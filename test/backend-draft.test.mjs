// The injected gh runs a local fixture script with no GitHub credentials.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { publishDraftAssets } from '../scripts/backend-draft.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceName = 'source.tar.gz';
const sumsName = 'SHA256SUMS.txt';
const draftId = 'original-draft';
const binName = 'bin-a';

function sourceArchive(dir, formatArgs = [], names = ['.']) {
  return execFileSync('tar', [...formatArgs, '-czf', '-', ...names], {
    cwd: dir, env: { ...process.env, COPYFILE_DISABLE: '1', TAR_OPTIONS: '' }
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-draft-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source');
  const outDir = path.join(root, 'out');
  const draftDir = path.join(root, 'draft');
  const callsFile = path.join(root, 'calls.log');
  const stateFile = path.join(root, 'release.json');
  const gh = path.join(root, 'fake-gh.mjs');
  for (const dir of [sourceDir, outDir, draftDir]) fs.mkdirSync(dir);
  fs.writeFileSync(callsFile, '');
  const setRelease = release => fs.writeFileSync(stateFile, JSON.stringify(release));
  setRelease({ id: draftId, isDraft: true });
  fs.writeFileSync(gh, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const argv = process.argv.slice(2);",
    "fs.appendFileSync('calls.log', JSON.stringify(argv) + '\\n');",
    "const flag = name => argv[argv.indexOf(name) + 1];",
    "const release = JSON.parse(fs.readFileSync('release.json', 'utf8'));",
    "if (argv[1] === 'view') {",
    "  release.assets = fs.readdirSync('draft').map(name => ({ name, state: 'uploaded' }));",
    "  const selected = flag('--json').split(',').map(field => [field, release[field]]);",
    "  process.stdout.write(JSON.stringify(Object.fromEntries(selected)));",
    "} else if (argv[1] === 'download') {",
    "  const name = flag('--pattern');",
    "  fs.copyFileSync(path.join('draft', name), path.join(flag('--dir'), name));",
    "} else if (argv[1] === 'upload') {",
    "  fs.copyFileSync(argv[3], path.join('draft', path.basename(argv[3])), fs.constants.COPYFILE_EXCL);",
    "} else {",
    "  throw new Error('Unexpected gh command: ' + argv.join(' '));",
    "}"
  ].join('\n'));
  const sourceFile = path.join(sourceDir, 'server.go');
  fs.writeFileSync(sourceFile, 'package main\n');
  const time = new Date('2026-01-01T12:00:00.125Z');
  fs.utimesSync(sourceFile, time, time);
  const source = sourceArchive(sourceDir);
  fs.writeFileSync(path.join(outDir, sourceName), source);
  fs.writeFileSync(path.join(outDir, binName), 'binary a');
  const options = {
    outDir, assetNames: [binName, sourceName], sourceName,
    repo: 'fixture/backend', tag: 'backend-v4.30.0-magpie.1', env: {},
    execFile: (command, args, opts) => {
      assert.equal(command, 'gh');
      return execFileSync(process.execPath, [gh, ...args], { ...opts, cwd: root });
    }
  };
  const calls = () => fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const uploads = () => calls().filter(args => args[1] === 'upload').map(args => path.basename(args[3]));
  return { options, outDir, draftDir, sourceDir, sourceFile, source, calls, uploads, setRelease };
}

function changeReleaseAfter(f, command, release) {
  const execFile = f.options.execFile;
  f.options.execFile = (program, args, opts) => {
    const result = execFile(program, args, opts);
    if (args[1] === command) f.setRelease(release);
    return result;
  };
}

it('resumes a partial draft with a real tar member mtime change and hashes the archive already in the draft', t => {
  const f = fixture(t);
  const later = new Date('2026-01-02T12:00:00.625Z');
  fs.utimesSync(f.sourceFile, later, later);
  const rebuilt = sourceArchive(f.sourceDir);
  assert.notDeepEqual(zlib.gunzipSync(rebuilt), zlib.gunzipSync(f.source), 'tar headers must differ');
  fs.writeFileSync(path.join(f.outDir, sourceName), rebuilt);
  fs.writeFileSync(path.join(f.draftDir, sourceName), f.source);

  const result = publishDraftAssets(f.options);
  assert.deepEqual(result.uploaded, [binName, sumsName]);
  assert.deepEqual(f.uploads(), result.uploaded);
  assert.deepEqual(fs.readFileSync(path.join(f.draftDir, sourceName)), f.source);
  const sums = fs.readFileSync(path.join(f.draftDir, sumsName), 'utf8');
  assert.equal(sums, hash('binary a') + '  ' + binName + '\n' + hash(f.source) + '  ' + sourceName + '\n');
  assert.equal(fs.readFileSync(path.join(f.outDir, sumsName), 'utf8'), sums);
  assert.notEqual(hash(rebuilt), hash(f.source));

  assert.deepEqual(publishDraftAssets(f.options).uploaded, []);
  assert.deepEqual(f.uploads(), [binName, sumsName]);
});

it('resumes PAX archives with long paths and changed timestamp metadata', t => {
  const f = fixture(t);
  const longFile = path.join(f.sourceDir, 'a'.repeat(110) + '.go');
  fs.writeFileSync(longFile, 'package main\n');
  const earlier = new Date('2026-01-01T12:00:00.125Z');
  const later = new Date('2026-01-02T12:00:00.625Z');
  fs.utimesSync(longFile, earlier, earlier);
  const original = sourceArchive(f.sourceDir, ['--format=pax']);
  fs.utimesSync(longFile, later, later);
  const rebuilt = sourceArchive(f.sourceDir, ['--format=pax']);
  assert.notDeepEqual(zlib.gunzipSync(rebuilt), zlib.gunzipSync(original));
  fs.writeFileSync(path.join(f.draftDir, sourceName), original);
  fs.writeFileSync(path.join(f.outDir, sourceName), rebuilt);

  assert.deepEqual(publishDraftAssets(f.options).uploaded, [binName, sumsName]);
  const sums = fs.readFileSync(path.join(f.draftDir, sumsName), 'utf8');
  assert.ok(sums.includes(hash(original) + '  ' + sourceName + '\n'));
});

it('rejects a changed file payload in a rebuilt source archive before uploading', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.draftDir, sourceName), f.source);
  fs.writeFileSync(f.sourceFile, 'package test\n');
  fs.writeFileSync(path.join(f.outDir, sourceName), sourceArchive(f.sourceDir));
  assert.throws(() => publishDraftAssets(f.options), /Existing source archive content differs/);
  assert.deepEqual(f.uploads(), []);
});

// Alter the header of a real single-member USTAR archive so the same mode and link
// tests run on Windows without creating privileged symlinks or changing POSIX modes.
function editTarMember(archive, fields) {
  const tar = zlib.gunzipSync(archive);
  const header = tar.subarray(0, 512);
  for (const [offset, value] of fields) header.write(value, offset, 'latin1');
  header.fill(0x20, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return zlib.gzipSync(tar);
}

it('rejects changed archive paths, permissions, member types, and link targets', t => {
  const f = fixture(t);
  const empty = path.join(f.sourceDir, 'empty');
  fs.writeFileSync(empty, '');
  const regular = sourceArchive(f.sourceDir, ['--format=ustar'], ['empty']);
  const link = editTarMember(regular, [[156, '2'], [157, 'file-a']]);
  for (const [label, original, changed] of [
    ['path', regular, editTarMember(regular, [[0, 'other']])],
    ['permission', editTarMember(regular, [[100, '0000644\0']]), editTarMember(regular, [[100, '0000744\0']])],
    ['type', regular, editTarMember(regular, [[156, '5']])],
    ['link target', link, editTarMember(link, [[157, 'file-b']])]
  ]) {
    fs.writeFileSync(path.join(f.outDir, sourceName), original);
    fs.writeFileSync(path.join(f.draftDir, sourceName), changed);
    assert.throws(() => publishDraftAssets(f.options), /Existing source archive content differs/, label);
    assert.deepEqual(f.uploads(), [], label);
  }
});

it('rejects tar mode digits after a NUL terminator before uploading', t => {
  const f = fixture(t);
  const source = sourceArchive(f.sourceDir, ['--format=ustar'], ['server.go']);
  const original = editTarMember(source, [[100, '0000755\0']]);
  fs.writeFileSync(path.join(f.outDir, sourceName), original);

  for (const mode of ['\x00000755\0', '0000\x00755']) {
    fs.writeFileSync(path.join(f.draftDir, sourceName), editTarMember(source, [[100, mode]]));
    assert.throws(() => publishDraftAssets(f.options), /Invalid octal field in source tar header/);
    assert.deepEqual(f.uploads(), []);
  }
});

for (const [label, manifest, error] of [
  ['a wrong digest', (correct, wrong) => wrong, /disagrees on source\.tar\.gz/],
  ['two correct entries', correct => correct + correct, /Duplicate SHA256SUMS\.txt entry: source\.tar\.gz/],
  ['a wrong entry followed by a correct duplicate', (correct, wrong) => wrong + correct, /Duplicate SHA256SUMS\.txt entry: source\.tar\.gz/]
]) {
  it('rejects an existing SHA256SUMS.txt with ' + label + ' before any upload', t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.draftDir, sourceName), f.source);
    const correct = hash(f.source) + '  ' + sourceName + '\n';
    const wrong = hash('corrupt') + '  ' + sourceName + '\n';
    fs.writeFileSync(path.join(f.draftDir, sumsName), hash('binary a') + '  ' + binName + '\n' + manifest(correct, wrong));
    assert.throws(() => publishDraftAssets(f.options), error);
    assert.deepEqual(f.uploads(), []);
  });
}

it('stops before the first upload when the release is published during asset verification', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.draftDir, sourceName), f.source);
  changeReleaseAfter(f, 'download', { id: draftId, isDraft: false });

  assert.throws(() => publishDraftAssets(f.options), /Refusing to touch non-draft release/);
  assert.deepEqual(f.uploads(), []);
});

it('stops between regular asset uploads when the tag points to a replacement draft', t => {
  const f = fixture(t);
  changeReleaseAfter(f, 'upload', { id: 'replacement-draft', isDraft: true });

  assert.throws(() => publishDraftAssets(f.options), /Draft release identity changed/);
  assert.deepEqual(f.uploads(), [binName]);
});

it('rechecks the draft before uploading SHA256SUMS.txt after the final regular asset', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.draftDir, sourceName), f.source);
  changeReleaseAfter(f, 'upload', { id: draftId, isDraft: false });

  assert.throws(() => publishDraftAssets(f.options), /Refusing to touch non-draft release/);
  assert.deepEqual(f.uploads(), [binName]);
  assert.equal(fs.existsSync(path.join(f.draftDir, sumsName)), false);
});

it('refuses to reconcile a draft that differs from the one verified by the workflow', t => {
  const f = fixture(t);
  f.options.expectedDraftId = draftId;
  f.setRelease({ id: 'replacement-draft', isDraft: true });

  assert.throws(() => publishDraftAssets(f.options), /Draft release identity changed/);
  assert.deepEqual(f.calls().map(args => args[1]), ['view']);
});

it('the workflow reports the first upload count and zero on re-entry', t => {
  const f = fixture(t);
  const workflow = fs.readFileSync(new URL('../.github/workflows/publish-backend.yml', import.meta.url), 'utf8');
  const [, uploadAndLog] = workflow.match(/await import\('\.\/scripts\/backend-draft\.mjs'\);\r?\n([\s\S]+?)\r?\n +JS\b/);
  const { repo, tag, assetNames, env, execFile } = f.options;
  const run = () => {
    const logs = [];
    runInNewContext(uploadAndLog, {
      repo, release: { tag }, outDir: f.outDir, sourceName, assetNames,
      process: { env: { BACKEND_DRAFT_ID: draftId } },
      publishDraftAssets: opts => publishDraftAssets({ ...opts, execFile, env }),
      console: { log: message => logs.push(message) }
    });
    return logs.join('\n');
  };

  assert.match(run(), /now carries 3 newly uploaded assets/);
  assert.match(run(), /now carries 0 newly uploaded assets/);
  assert.deepEqual(f.uploads(), [binName, sourceName, sumsName]);
  const calls = f.calls();
  for (const [i, argv] of calls.entries()) {
    if (argv[1] === 'upload') {
      assert.deepEqual(calls[i - 1], ['release', 'view', tag, '--repo', repo, '--json', 'id,isDraft']);
    }
  }
});
