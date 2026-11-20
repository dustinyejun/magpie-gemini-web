import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { backendChannel, binaryPath, ensureBackend, installBackend, installLocalBackend, pinnedBinary,
  PINNED_BINARIES, UPSTREAM_BINARIES } from '../lib/native.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-release-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, 'bin'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 8083, multi_turn: true }));
  fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify({ apiKey: 'gw_fixture', adminToken: 'fixture_admin' }));
  fs.writeFileSync(path.join(dataDir, 'gemini.db'), 'existing account database');
  return dataDir;
}
function pinFixture(t, pins, bytes, target = 'darwin-arm64') {
  const previous = pins[target];
  pins[target] = { ...previous, sha256: hash(bytes) };
  t.after(() => { pins[target] = previous; });
}

it('starts a previously installed Argon build only when its digest matches', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64'
}, t => {
  const dataDir = fixture(t);
  const executable = binaryPath(dataDir, 'darwin');
  const script = fileURLToPath(new URL('../scripts/backend-argon.mjs', import.meta.url));
  const bytes = Buffer.from('#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(dataDir, 'argon-build.json'), JSON.stringify({
    version: '4.30.0-argon.1',
    sourceCommit: 'c90c9320cbb6c34a087e71c741c0ba79e4513bd3',
    sha256: hash(bytes),
    platform: 'darwin',
    arch: 'arm64'
  }));
  const start = () => spawnSync(process.execPath, [script, 'start'], {
    env: { ...process.env, GEMINI_WEB_DATA_DIR: dataDir },
    encoding: 'utf8',
    timeout: 10000
  });

  fs.writeFileSync(executable, 'wrong binary bytes', { mode: 0o700 });
  const refused = start();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Binary integrity verification failed/);

  fs.writeFileSync(executable, bytes);
  const accepted = start();
  assert.equal(accepted.status, 0, accepted.stderr);
});

it('ships pinned optimized and rollback downloads for all six supported targets', () => {
  const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
  assert.deepEqual(Object.keys(PINNED_BINARIES).sort(), targets);
  for (const key of targets) {
    const [platform, arch] = key.split('-');
    const optimized = pinnedBinary(platform, arch);
    const upstream = pinnedBinary(platform, arch, 'upstream');
    assert.match(optimized.url, /^https:\/\/github\.com\/dustinyejun\/magpie-gemini-web\/releases\/download\/backend-v4\.31\.0-magpie\.1\//);
    assert.match(optimized.sha256, /^[a-f0-9]{64}$/);
    assert.match(upstream.url, /^https:\/\/github\.com\/zexadev\/gemini-web2api-go\/releases\/download\/v4\.31\.0\//);
    assert.notEqual(optimized.sha256, upstream.sha256);
    assert.equal(optimized.url.endsWith('.exe'), platform === 'win32');
  }
  assert.throws(() => pinnedBinary('linux', 'mips'), /No gemini-web2api-go/);
  assert.throws(() => pinnedBinary('linux', 'x64', 'unknown'), /Invalid backend channel/);
});

it('upgrades a stopped upstream backend to the optimized release without changing account data', async t => {
  const dataDir = fixture(t);
  const old = Buffer.from('upstream fixture');
  const next = Buffer.from('optimized fixture');
  pinFixture(t, UPSTREAM_BINARIES, old);
  pinFixture(t, PINNED_BINARIES, next);
  const bin = binaryPath(dataDir, 'darwin');
  fs.writeFileSync(bin, old);
  const calls = [];
  let spawned = false;
  await ensureBackend({ dataDir, platform: 'darwin', arch: 'arm64',
    fetchFn: async url => {
      calls.push(url);
      if (url === pinnedBinary('darwin', 'arm64').url) return new Response(next);
      if (!spawned) throw new Error('ECONNREFUSED');
      return Response.json({ data: [] });
    },
    spawnFn: () => { spawned = true; return { pid: 1234, on() {}, unref() {} }; }
  });
  assert.deepEqual(fs.readFileSync(bin), next);
  assert.ok(spawned);
  assert.ok(calls.includes(pinnedBinary('darwin', 'arm64').url));
  assert.equal(backendChannel(dataDir), 'optimized');
  assert.equal(fs.readFileSync(path.join(dataDir, 'gemini.db'), 'utf8'), 'existing account database');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'))).multi_turn, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'))).apiKey, 'gw_fixture');
});

it('persists an explicit upstream rollback across automatic starts and can switch back', async t => {
  const dataDir = fixture(t);
  const upstream = Buffer.from('upstream fixture');
  const optimized = Buffer.from('optimized fixture');
  pinFixture(t, UPSTREAM_BINARIES, upstream);
  pinFixture(t, PINNED_BINARIES, optimized);
  await installBackend({ dataDir, platform: 'darwin', arch: 'arm64', channel: 'upstream',
    fetchFn: async url => {
      assert.equal(url, pinnedBinary('darwin', 'arm64', 'upstream').url);
      return new Response(upstream);
    }
  });
  assert.equal(backendChannel(dataDir), 'upstream');
  let spawned = false;
  await ensureBackend({ dataDir, platform: 'darwin', arch: 'arm64',
    fetchFn: async url => {
      assert.ok(url.startsWith('http://127.0.0.1:8083/'), 'rollback must not redownload the default build');
      if (!spawned) throw new Error('ECONNREFUSED');
      return Response.json({ data: [] });
    },
    spawnFn: () => { spawned = true; return { pid: 1234, on() {}, unref() {} }; }
  });
  assert.ok(spawned);
  await installBackend({ dataDir, platform: 'darwin', arch: 'arm64', fetchFn: async () => new Response(optimized) });
  assert.equal(backendChannel(dataDir), 'optimized');
  assert.deepEqual(fs.readFileSync(binaryPath(dataDir, 'darwin')), optimized);
});

it('a failed upgrade keeps the previous binary, channel, config, secrets and database', async t => {
  const dataDir = fixture(t);
  const bin = binaryPath(dataDir, 'darwin');
  fs.writeFileSync(bin, 'previous binary');
  fs.writeFileSync(path.join(dataDir, 'backend-channel.json'), JSON.stringify({ channel: 'upstream' }));
  const paths = [bin, ...['backend-channel.json', 'config.json', 'secrets.json', 'gemini.db'].map(name => path.join(dataDir, name))];
  const before = paths.map(file => fs.readFileSync(file));
  for (const response of [() => new Response('offline', { status: 503 }), () => new Response('corrupt binary')]) {
    await assert.rejects(installBackend({ dataDir, platform: 'darwin', arch: 'arm64', fetchFn: async () => response() }), /HTTP 503|SHA256 checksum mismatch/);
    for (let i = 0; i < paths.length; i++) assert.deepEqual(fs.readFileSync(paths[i]), before[i]);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'bin')), ['gemini-web2api-go']);
  }
});

it('install-local rejects an artifact that does not match the committed pin and keeps the directory', async t => {
  const dataDir = fixture(t);
  const config = fs.readFileSync(path.join(dataDir, 'config.json'));
  const secrets = fs.readFileSync(path.join(dataDir, 'secrets.json'));
  const bad = path.join(dataDir, 'not-the-release');
  fs.writeFileSync(bad, 'not the pinned release');
  // A previous install must survive a failed replacement untouched.
  const bin = binaryPath(dataDir, 'darwin');
  const channel = path.join(dataDir, 'backend-channel.json');
  fs.writeFileSync(bin, 'previous verified binary');
  fs.writeFileSync(channel, JSON.stringify({ channel: 'upstream' }));
  await assert.rejects(
    async () => installLocalBackend({ dataDir, platform: 'darwin', arch: 'arm64', assetPath: bad }),
    /SHA256 checksum mismatch/
  );
  assert.deepEqual(fs.readFileSync(bin), Buffer.from('previous verified binary'));
  assert.equal(JSON.parse(fs.readFileSync(channel, 'utf8')).channel, 'upstream');
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'bin')), ['gemini-web2api-go']);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'config.json')), config);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'secrets.json')), secrets);
  assert.equal(fs.existsSync(dataDir), true);
});

it('install-local installs the hash-verified bytes even when the source is swapped right after the read', async t => {
  const dataDir = fixture(t);
  const good = Buffer.from('verified release bytes');
  pinFixture(t, PINNED_BINARIES, good);
  const asset = path.join(dataDir, 'the-release');
  fs.writeFileSync(asset, good);
  const bin = binaryPath(dataDir, 'darwin');
  fs.writeFileSync(bin, 'previous verified binary');
  const channel = path.join(dataDir, 'backend-channel.json');
  fs.writeFileSync(channel, JSON.stringify({ channel: 'upstream' }));
  // Deterministic swap: the moment the installer reads the artifact, a concurrent build
  // replaces the same path. Only the already-verified bytes may be installed; a second
  // open of the source path would pick up the replacement instead.
  const realReadFileSync = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (file, ...rest) => {
    const out = realReadFileSync(file, ...rest);
    if (file === asset) {
      reads += 1;
      fs.writeFileSync(asset, 'swapped by a parallel build');
    }
    return out;
  };
  t.after(() => { fs.readFileSync = realReadFileSync; });
  const result = await installLocalBackend({ dataDir, platform: 'darwin', arch: 'arm64', assetPath: asset });
  assert.equal(reads, 1);
  assert.deepEqual(fs.readFileSync(bin), good);
  assert.equal(result.sha256, hash(good));
  assert.equal(JSON.parse(fs.readFileSync(channel, 'utf8')).channel, 'optimized');
  assert.deepEqual(realReadFileSync(asset), Buffer.from('swapped by a parallel build'));
});

it('install-local restores an upstream installation when committing the optimized channel fails', async t => {
  const dataDir = fixture(t);
  const platform = process.platform;
  const arch = process.arch;
  const upstream = Buffer.from('upstream fixture');
  const optimized = Buffer.from('optimized fixture');
  pinFixture(t, UPSTREAM_BINARIES, upstream, platform + '-' + arch);
  pinFixture(t, PINNED_BINARIES, optimized, platform + '-' + arch);
  const bin = binaryPath(dataDir, platform);
  const assetPath = path.join(dataDir, 'local-release');
  const channel = path.join(dataDir, 'backend-channel.json');
  const oldChannel = '{ "channel": "upstream" }\n';
  fs.writeFileSync(bin, upstream, { mode: 0o751 });
  fs.writeFileSync(channel, oldChannel, { mode: 0o600 });
  fs.writeFileSync(assetPath, optimized);
  const oldMode = fs.statSync(bin).mode;
  const dataFiles = ['config.json', 'secrets.json', 'gemini.db'].map(name => path.join(dataDir, name));
  const oldData = dataFiles.map(file => fs.readFileSync(file));

  const failure = Object.assign(new Error('injected channel commit failure'), { code: 'ENOSPC' });
  const rename = fs.renameSync;
  const commit = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === channel) {
      assert.deepEqual(fs.readFileSync(bin), optimized);
      assert.equal(JSON.parse(fs.readFileSync(from, 'utf8')).channel, 'optimized');
      throw failure;
    }
    return rename(from, to);
  });
  await assert.rejects(installLocalBackend({ dataDir, platform, arch, assetPath }), error => error === failure);
  commit.mock.restore();

  assert.deepEqual(fs.readFileSync(bin), upstream);
  assert.equal(fs.statSync(bin).mode, oldMode);
  assert.equal(fs.readFileSync(channel, 'utf8'), oldChannel);
  assert.equal(backendChannel(dataDir), 'upstream');
  assert.deepEqual(dataFiles.map(file => fs.readFileSync(file)), oldData);
  assert.deepEqual(fs.readdirSync(path.dirname(bin)), [path.basename(bin)]);
  assert.equal(fs.existsSync(path.join(dataDir, '.setup.lock')), false);
  assert.deepEqual(fs.readdirSync(dataDir).filter(name => name.endsWith('.tmp')), []);

  let spawned = false;
  await ensureBackend({
    dataDir, platform, arch,
    fetchFn: async url => {
      assert.ok(url.startsWith('http://127.0.0.1:8083/'), 'restored backend must not download another binary');
      if (!spawned) throw new Error('ECONNREFUSED');
      return Response.json({ data: [] });
    },
    spawnFn: executable => {
      assert.equal(executable, bin);
      assert.deepEqual(fs.readFileSync(executable), upstream);
      spawned = true;
      return { on() {}, unref() {} };
    }
  });
  assert.ok(spawned, 'the original installation can still start under its upstream pin');
});

it('install-local rolls back the new exe on channel commit failure with no previous binary', async t => {
  const dataDir = fixture(t);
  const platform = 'win32';
  const arch = 'x64';
  const bytes = Buffer.from('optimized exe fixture');
  const bin = binaryPath(dataDir, platform);
  const channel = path.join(dataDir, 'backend-channel.json');
  const assetPath = path.join(dataDir, 'local-release.exe');
  pinFixture(t, PINNED_BINARIES, bytes, 'win32-x64');
  fs.writeFileSync(assetPath, bytes);
  const failure = Object.assign(new Error('injected channel commit failure'), { code: 'ENOSPC' });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === channel) {
      assert.deepEqual(fs.readFileSync(bin), bytes);
      throw failure;
    }
    return rename(from, to);
  });

  await assert.rejects(installLocalBackend({ dataDir, platform, arch, assetPath }), error => error === failure);
  assert.deepEqual(fs.readdirSync(path.dirname(bin)), []);
  assert.equal(fs.existsSync(channel), false);
});

it('install-local reports both errors and keeps the previous binary backup if rollback fails', async t => {
  const dataDir = fixture(t);
  const platform = 'win32';
  const arch = 'x64';
  const upstream = Buffer.from('old exe fixture');
  const optimized = Buffer.from('new exe fixture');
  const bin = binaryPath(dataDir, platform);
  const channel = path.join(dataDir, 'backend-channel.json');
  const assetPath = path.join(dataDir, 'local-release.exe');
  pinFixture(t, PINNED_BINARIES, optimized, 'win32-x64');
  fs.writeFileSync(bin, upstream);
  fs.writeFileSync(channel, '{"channel":"upstream"}\n');
  fs.writeFileSync(assetPath, optimized);

  const failure = Object.assign(new Error('injected channel commit failure'), { code: 'ENOSPC' });
  const rollbackFailure = Object.assign(new Error('injected locked exe'), { code: 'EPERM' });
  const rename = fs.renameSync;
  let attemptedCommit = false;
  let backup;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === channel) {
      attemptedCommit = true;
      throw failure;
    }
    if (to === bin && attemptedCommit) {
      backup = from;
      throw rollbackFailure;
    }
    return rename(from, to);
  });

  await assert.rejects(installLocalBackend({ dataDir, platform, arch, assetPath }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure, rollbackFailure]);
    assert.ok(error.message.includes(failure.message));
    assert.ok(error.message.includes(rollbackFailure.message));
    assert.ok(error.message.includes(backup));
    return true;
  });
  assert.deepEqual(fs.readFileSync(backup), upstream);
  assert.equal(backendChannel(dataDir), 'upstream');
});
