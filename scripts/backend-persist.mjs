#!/usr/bin/env node
// Persistent install check. Unlike backend-smoke.mjs, the installer does not delete the
// data directory. Process 1 installs from the local release artifact and exits. Process 2
// starts that same directory and is not allowed to download.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { ensureBackend, computeFileHash, pinnedBinary } = await import(pathToFileURL(path.join(root, 'lib/native.mjs')));
const release = JSON.parse(fs.readFileSync(path.join(root, 'lib/backend-release.json'), 'utf8'));

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

if (process.argv[2] === '--check') {
  const dir = process.argv[3];
  const pin = pinnedBinary();
  const held = new Set();
  const proxyServer = net.createServer(socket => {
    held.add(socket);
    socket.on('close', () => held.delete(socket));
    socket.on('error', () => {});
  });
  const proxyPort = await listen(proxyServer);
  const proxy = `http://127.0.0.1:${proxyPort}`;
  let child;
  let exited;
  try {
    const setup = await ensureBackend({
      dataDir: dir,
      fetchFn: async (url, init) => {
        const target = new URL(url);
        if (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost') {
          throw new Error(`persistent install must not download: ${target.origin}`);
        }
        return fetch(url, init);
      },
      spawnFn: (file, argv, options) => {
        const env = { ...options.env, TIKTOKEN_CACHE_DIR: path.join(dir, 'tokenizer'),
          HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
          NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
        delete env.SQL_DSN;
        child = spawn(file, argv, { ...options, env, cwd: dir, detached: false });
        exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
        return child;
      }
    });
    const installed = path.join(dir, 'bin', process.platform === 'win32' ? 'gemini-web2api-go.exe' : 'gemini-web2api-go');
    assert.equal(computeFileHash(installed), pin.sha256);
    const health = await (await fetch(`${setup.origin}/`)).json();
    assert.equal(health.version, release.version);
    assert.equal(health.capabilities?.account_proxy_binding, true);
    assert.equal((await fetch(`${setup.baseURL}/models`)).status, 401);
    const authed = await fetch(`${setup.baseURL}/models`, { headers: { Authorization: `Bearer ${setup.apiKey}` } });
    assert.equal(authed.status, 200);
    console.log(JSON.stringify({ version: health.version, sha256: pin.sha256, auth: 'passed' }));
  } catch (error) {
    const logPath = path.join(dir, 'backend.log');
    if (fs.existsSync(logPath)) console.error(fs.readFileSync(logPath, 'utf8'));
    throw error;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, pause(5000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    for (const socket of held) socket.destroy();
    await new Promise(resolve => proxyServer.close(resolve));
  }
  process.exit(0);
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${args.join(' ')} exited ${code}`));
    });
    child.once('error', reject);
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-persist-'));
const probe = net.createServer();
const port = await listen(probe);
await new Promise(resolve => probe.close(resolve));
const configPath = path.join(dir, 'config.json');
const secretsPath = path.join(dir, 'secrets.json');
const config = `${JSON.stringify({ host: '127.0.0.1', port, log_requests: false,
  gemini_bl_auto: false, multi_turn: false, temporary_chat: true }, null, 2)}\n`;
const secrets = `${JSON.stringify({
  apiKey: 'gw_' + crypto.randomBytes(32).toString('hex'),
  adminToken: crypto.randomBytes(32).toString('hex')
}, null, 2)}\n`;
fs.writeFileSync(configPath, config, { mode: 0o600 });
fs.writeFileSync(secretsPath, secrets, { mode: 0o600 });
const configBytes = fs.readFileSync(configPath);
const secretBytes = fs.readFileSync(secretsPath);

try {
  await run([path.join(root, 'scripts/backend.mjs'), 'install-local', `--data-dir=${dir}`]);
  assert.equal(fs.existsSync(dir), true, 'install-local must not delete the data directory');
  assert.deepEqual(fs.readFileSync(configPath), configBytes);
  assert.deepEqual(fs.readFileSync(secretsPath), secretBytes);
  const pin = pinnedBinary();
  const installed = path.join(dir, 'bin', process.platform === 'win32' ? 'gemini-web2api-go.exe' : 'gemini-web2api-go');
  assert.equal(computeFileHash(installed), pin.sha256);
  await run([path.join(root, 'scripts/backend-persist.mjs'), '--check', dir]);
  assert.equal(fs.existsSync(dir), true, 'the second process must keep the same directory');
  assert.deepEqual(fs.readFileSync(configPath), configBytes);
  assert.deepEqual(fs.readFileSync(secretsPath), secretBytes);
  console.log(JSON.stringify({ install: 'persistent', download: 'forbidden', reusedConfig: true, sha256: pin.sha256 }));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
