// Draft asset reconciliation for backend releases (.github/workflows/publish-backend.yml).
//
// A resumed upload must not trust locally rebuilt bytes when the private draft already
// holds an asset. Timestamps can change in both the gzip and tar layers, so an existing
// source archive is compared by member. The draft keeps its original compressed bytes
// when the members match. Other existing assets must match the local bytes exactly.
// SHA256SUMS.txt covers the retained bytes and any missing assets from the local build.
// An existing manifest must match those hashes. Only missing assets are uploaded.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const tarBlockSize = 512;
const ignoredPaxMetadata = new Set([
  'atime', 'ctime', 'mtime', 'LIBARCHIVE.creationtime',
  'uid', 'gid', 'uname', 'gname',
  'LIBARCHIVE.xattr.com.apple.provenance', 'SCHILY.xattr.com.apple.provenance'
]);

function tarString(bytes, start, end) {
  return bytes.toString('latin1', start, end).split('\0', 1)[0];
}

function tarOctal(bytes, start, end) {
  const field = bytes.toString('latin1', start, end).replace(/^ +|[ \0]+$/g, '');
  if (!field || /[^0-7]/.test(field)) throw new Error('Invalid octal field in source tar header');
  return Number.parseInt(field, 8);
}

function paxFields(bytes) {
  const fields = new Map();
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) throw new Error('Invalid source tar PAX record');
    const length = bytes.toString('latin1', offset, space);
    const end = offset + Number(length);
    const equals = bytes.indexOf(0x3d, space + 1);
    if (!/^[1-9][0-9]*$/.test(length) || end > bytes.length || equals <= space + 1 ||
        equals >= end - 1 || bytes[end - 1] !== 0x0a) {
      throw new Error('Invalid source tar PAX record');
    }
    const key = bytes.toString('latin1', space + 1, equals);
    if (!ignoredPaxMetadata.has(key)) {
      // Reject extensions that could change extraction, such as ACLs or sparse maps.
      if (!['path', 'linkpath', 'size'].includes(key) || fields.has(key) || equals === end - 2) {
        throw new Error('Unsupported source tar PAX field: ' + JSON.stringify(key));
      }
      fields.set(key, bytes.toString('latin1', equals + 1, end - 1));
    }
    offset = end;
  }
  return fields;
}

function sourcePath(name, directory = false) {
  if (directory && (name === '.' || name === './')) return '.';
  const relative = name.replace(/^\.\//, '');
  const member = directory ? relative.replace(/\/$/, '') : relative;
  if (member.includes('\0') || member.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('Invalid source tar path: ' + JSON.stringify(name));
  }
  return member;
}

// Read only the member headers and payloads. Draft paths and links are never extracted.
function sourceMembers(compressed) {
  const tar = zlib.gunzipSync(compressed);
  const members = new Map();
  let pax;
  let longName;
  let longLink;
  for (let offset = 0; offset + tarBlockSize <= tar.length;) {
    const header = tar.subarray(offset, offset + tarBlockSize);
    if (header.every(value => value === 0)) {
      const end = tar.subarray(offset);
      if (!pax && longName === undefined && longLink === undefined && end.length >= 2 * tarBlockSize &&
          end.length % tarBlockSize === 0 && end.every(value => value === 0)) return members;
      break;
    }
    const format = header.toString('latin1', 257, 265);
    const ustar = format === 'ustar\x0000';
    const gnu = format === 'ustar  \0';
    if (!ustar && !gnu) throw new Error('Unsupported source tar header format');
    const checksum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 0x20 : value), 0);
    if (checksum !== tarOctal(header, 148, 156)) throw new Error('Invalid source tar header checksum');

    const type = tarString(header, 156, 157) || '0';
    const extension = ['x', 'L', 'K'].includes(type);
    const paxSize = extension ? undefined : pax?.get('size');
    if (paxSize !== undefined && !/^[0-9]+$/.test(paxSize)) throw new Error('Invalid source tar PAX size');
    const size = paxSize === undefined ? tarOctal(header, 124, 136) : Number(paxSize);
    const start = offset + tarBlockSize;
    offset = start + Math.ceil(size / tarBlockSize) * tarBlockSize;
    if (!Number.isSafeInteger(size) || offset > tar.length) throw new Error('Truncated source tar member');
    const contents = tar.subarray(start, start + size);

    if (extension) {
      if (type === 'x' && ustar && !pax && longName === undefined && longLink === undefined) {
        pax = paxFields(contents);
      } else if (gnu && !pax && contents.length > 1 && contents.indexOf(0) === contents.length - 1) {
        if (type === 'L' && longName === undefined) longName = tarString(contents);
        else if (type === 'K' && longLink === undefined) longLink = tarString(contents);
        else throw new Error('Unexpected source tar extension');
      } else {
        throw new Error('Unexpected source tar extension');
      }
      continue;
    }

    if (!['0', '1', '2', '5'].includes(type) || (type !== '0' && size !== 0)) {
      throw new Error('Unsupported source tar member type: ' + JSON.stringify(type));
    }
    const prefix = ustar ? tarString(header, 345, 500) : '';
    const headerName = (prefix ? prefix + '/' : '') + tarString(header, 0, 100);
    const name = sourcePath(pax?.get('path') ?? longName ?? headerName, type === '5');
    const link = pax?.get('linkpath') ?? longLink ?? tarString(header, 157, 257);
    if ((type === '1' || type === '2') ? !link || link.includes('\0') : link !== '') {
      throw new Error('Invalid source tar link: ' + JSON.stringify(name));
    }
    if (type === '1' && !['0', '1'].includes(members.get(sourcePath(link))?.type)) {
      throw new Error('Missing source tar hard link target: ' + JSON.stringify(link));
    }
    if (members.has(name)) throw new Error('Duplicate source tar path: ' + JSON.stringify(name));
    members.set(name, { type, mode: tarOctal(header, 100, 108) & 0o7777, link, contents });
    pax = longName = longLink = undefined;
  }
  throw new Error('Invalid source tar end marker');
}

function sameSourceMembers(remote, local) {
  const existing = sourceMembers(remote);
  const expected = sourceMembers(local);
  if (existing.size !== expected.size) return false;
  for (const [name, { type, mode, link, contents }] of expected) {
    const member = existing.get(name);
    if (!member || member.type !== type || member.mode !== mode || member.link !== link ||
        !member.contents.equals(contents)) return false;
  }
  return true;
}

export function publishDraftAssets({ outDir, assetNames, sourceName, repo, tag, expectedDraftId,
  execFile = execFileSync, env = process.env }) {
  if (!Array.isArray(assetNames) || assetNames.length === 0) throw new Error('assetNames must be a non-empty array');
  if (!assetNames.includes(sourceName)) throw new Error(`assetNames must include the source archive: ${sourceName}`);
  if (assetNames.includes('SHA256SUMS.txt')) throw new Error('assetNames must not include SHA256SUMS.txt');
  const view = fields => JSON.parse(execFile('gh', ['release', 'view', tag, '--repo', repo, '--json', fields], { encoding: 'utf8', env }));
  const assertDraft = (release, id) => {
    if (release.isDraft !== true) throw new Error('Refusing to touch non-draft release ' + tag);
    if (typeof release.id !== 'string' || !release.id || (id !== undefined && release.id !== id)) {
      throw new Error('Draft release identity changed or could not be verified: ' + tag);
    }
  };
  const draft = view('id,isDraft,assets');
  assertDraft(draft, expectedDraftId);
  const existing = name => draft.assets.find(asset => asset.name === name);
  const uploaded = [];
  const upload = file => {
    assertDraft(view('id,isDraft'), draft.id);
    execFile('gh', ['release', 'upload', tag, file, '--repo', repo], { stdio: 'inherit', env });
    uploaded.push(path.basename(file));
  };

  const download = name => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-asset-'));
    try {
      execFile('gh', ['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', dir], { stdio: 'inherit', env });
      return fs.readFileSync(path.join(dir, name));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const uploadMissing = (name, bytes) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-upload-'));
    try {
      const file = path.join(dir, name);
      fs.writeFileSync(file, bytes);
      upload(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  // name -> bytes that must end up being what users download
  const retained = new Map();
  for (const name of assetNames) {
    const localBytes = fs.readFileSync(path.join(outDir, name));
    const remote = existing(name);
    if (!remote) {
      retained.set(name, localBytes);
      continue;
    }
    if (remote.state !== 'uploaded') throw new Error(`Draft asset ${name} is in state ${remote.state}`);
    const remoteBytes = download(name);
    if (name === sourceName) {
      // Rebuilt tar members can have different timestamps. Hash the draft's retained bytes.
      if (!sameSourceMembers(remoteBytes, localBytes)) {
        throw new Error(`Existing source archive content differs: ${name}`);
      }
      retained.set(name, remoteBytes);
      continue;
    }
    if (!remoteBytes.equals(localBytes)) throw new Error(`Existing asset differs: ${name}`);
    retained.set(name, remoteBytes);
  }

  const expected = new Map([...retained].map(([name, bytes]) => [name, hash(bytes)]));
  const manifest = [...expected.keys()].sort((a, b) => a.localeCompare(b))
    .map(name => expected.get(name) + '  ' + name + '\n').join('');
  const sumsPath = path.join(outDir, 'SHA256SUMS.txt');

  const remoteSums = existing('SHA256SUMS.txt');
  if (remoteSums) {
    if (remoteSums.state !== 'uploaded') throw new Error('Draft asset SHA256SUMS.txt is in state ' + remoteSums.state);
    const storedManifest = download('SHA256SUMS.txt').toString('utf8');
    const got = new Map();
    for (const line of storedManifest.split('\n').filter(Boolean)) {
      const match = /^([0-9a-f]{64})  (\S+)$/.exec(line);
      if (!match) throw new Error('Malformed SHA256SUMS line: ' + JSON.stringify(line));
      const [, digest, name] = match;
      if (got.has(name)) throw new Error('Duplicate SHA256SUMS.txt entry: ' + name);
      got.set(name, digest);
    }
    if (got.size !== expected.size) {
      throw new Error(`Existing SHA256SUMS.txt lists ${got.size} assets, expected ${expected.size}`);
    }
    for (const [name, digest] of expected) {
      if (got.get(name) !== digest) {
        throw new Error(`Existing SHA256SUMS.txt disagrees on ${name}: stored ${got.get(name)}, actual ${digest}`);
      }
    }
  }

  fs.writeFileSync(sumsPath, manifest);
  for (const name of assetNames) {
    if (existing(name)) continue;
    uploadMissing(name, retained.get(name));
  }
  if (!remoteSums) upload(sumsPath);
  return { uploaded };
}
