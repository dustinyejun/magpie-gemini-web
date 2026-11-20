import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { GeminiWebPlugin, AIStudioPlugin } from '../index.mjs';
import { binaryPath } from '../lib/native.mjs';
import {
  DEFAULT_BASE,
  PLUGIN_ICON,
  UNREACHABLE_HEADER,
  normalizeBaseURL,
  settings,
  credentials,
  listModels,
  forward
} from '../lib/backend.mjs';

// The plugin starts the backend it manages in the data dir; keep tests away from the real one.
process.env.GEMINI_WEB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-gemini-web-test-'));
process.env.AI_STUDIO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-studio-icon-test-'));
after(() => fs.rmSync(process.env.AI_STUDIO_DATA_DIR, { recursive: true, force: true }));

describe('1. URL normalization/root/subpath/HTTPS/local IPv6', () => {
  it('normalizes root path to /v1', () => {
    assert.equal(normalizeBaseURL('http://127.0.0.1:8083'), 'http://127.0.0.1:8083/v1');
    assert.equal(normalizeBaseURL('http://127.0.0.1:8083/'), 'http://127.0.0.1:8083/v1');
  });

  it('preserves existing /v1 and strips trailing slashes', () => {
    assert.equal(normalizeBaseURL('http://127.0.0.1:8083/v1'), 'http://127.0.0.1:8083/v1');
    assert.equal(normalizeBaseURL('http://127.0.0.1:8083/v1/'), 'http://127.0.0.1:8083/v1');
  });

  it('supports subpaths ending in /v1 on HTTPS', () => {
    assert.equal(normalizeBaseURL('https://gateway.example.com/proxy/v1'), 'https://gateway.example.com/proxy/v1');
    assert.equal(normalizeBaseURL('https://gateway.example.com/proxy/v1/'), 'https://gateway.example.com/proxy/v1');
  });

  it('supports local loopback IPv6 and localhost', () => {
    assert.equal(normalizeBaseURL('http://[::1]:8083'), 'http://[::1]:8083/v1');
    assert.equal(normalizeBaseURL('http://localhost:8083/'), 'http://localhost:8083/v1');
  });
});

describe('2. Reject remote HTTP, userinfo, query, fragment', () => {
  it('rejects remote HTTP', () => {
    assert.throws(() => normalizeBaseURL('http://remote-server.com/v1'), /HTTP only allowed for local loopback/);
  });

  it('rejects userinfo credentials in URL', () => {
    assert.throws(() => normalizeBaseURL('http://user:secret@127.0.0.1:8083/v1'), /credentials not allowed/);
  });

  it('rejects query parameters', () => {
    assert.throws(() => normalizeBaseURL('http://127.0.0.1:8083/v1?api_key=secret'), /query parameters not allowed/);
  });

  it('rejects URL fragments', () => {
    assert.throws(() => normalizeBaseURL('http://127.0.0.1:8083/v1#token'), /URL fragment not allowed/);
  });

  it('rejects invalid paths not ending in /v1', () => {
    assert.throws(() => normalizeBaseURL('http://127.0.0.1:8083/v2'), /path must end in \/v1/);
    assert.throws(() => normalizeBaseURL('http://127.0.0.1:8083/chat'), /path must end in \/v1/);
  });

  it('does not echo secret input in error message', () => {
    const sensitive = 'http://127.0.0.1:8083/v1?token=SUPER_SECRET_12345';
    try {
      normalizeBaseURL(sensitive);
      assert.fail('should have thrown');
    } catch (e) {
      assert.equal(e.message.includes('SUPER_SECRET_12345'), false);
    }
  });
});

describe('3. Invalid options validation', () => {
  it('accepts valid options and sets defaults', () => {
    const s = settings();
    assert.equal(s.baseURL, DEFAULT_BASE);
    assert.equal(s.allowTools, true);
    assert.equal(s.allowImages, true);
    assert.equal(settings({ allowImages: false }).allowImages, false);
    assert.equal(s.contextLimit, 1000000);
    assert.equal(s.outputLimit, 8192);
    assert.equal(s.requestTimeoutMs, 570000);
    assert.equal(s.modelTimeoutMs, 10000);
    assert.equal(s.stripCitations, true);
    assert.equal(s.proxy, '');
    assert.equal(settings({ stripCitations: false }).stripCitations, false);
    assert.equal(settings({ proxy: ' http://127.0.0.1:7890 ' }).proxy, 'http://127.0.0.1:7890');
  });

  it('rejects unknown options to catch typos', () => {
    assert.throws(() => settings({ unknownOption: true }), /Unknown plugin option/);
  });

  it('rejects invalid option types', () => {
    assert.throws(() => settings({ allowTools: 'yes' }), /allowTools: must be a boolean/);
    assert.throws(() => settings({ allowImages: 'no' }), /allowImages: must be a boolean/);
    assert.throws(() => settings({ contextLimit: -10 }), /contextLimit: must be a positive integer/);
    assert.throws(() => settings({ outputLimit: 0 }), /outputLimit: must be a positive integer/);
    assert.throws(() => settings({ outputLimit: 50000, contextLimit: 32768 }), /outputLimit: cannot exceed contextLimit/);
    assert.throws(() => settings({ requestTimeoutMs: 'slow' }), /requestTimeoutMs: must be a positive integer/);
    assert.throws(() => settings({ modelTimeoutMs: -1 }), /modelTimeoutMs: must be a positive integer/);
    assert.throws(() => settings({ stripCitations: 'off' }), /stripCitations: must be a boolean/);
    assert.throws(() => settings({ proxy: 123 }), /proxy: must be a string/);
    assert.throws(() => settings({ proxy: '127.0.0.1:7890' }), /代理地址/);
  });
});

describe('4. Auth metadata precedence and key CRLF', () => {
  it('extracts trimmed key and default baseURL', () => {
    const creds = credentials({ type: 'api', key: '  gw_testkey123  ' }, settings());
    assert.equal(creds.key, 'gw_testkey123');
    assert.equal(creds.baseURL, DEFAULT_BASE);
  });

  it('metadata.baseURL takes precedence over opts.baseURL', () => {
    const opts = settings({ baseURL: 'http://127.0.0.1:9000/v1' });
    const creds = credentials({
      type: 'api',
      key: 'gw_key',
      metadata: { baseURL: 'https://proxy.example.com/v1' }
    }, opts);
    assert.equal(creds.baseURL, 'https://proxy.example.com/v1');
  });

  it('rejects CR or LF in API key', () => {
    assert.throws(() => credentials({ type: 'api', key: 'gw_key\r\n' }, settings()), /API key must not contain newline/);
    assert.throws(() => credentials({ type: 'api', key: 'gw_\nkey' }, settings()), /API key must not contain newline/);
  });

  it('rejects empty or missing API key', () => {
    assert.throws(() => credentials({ type: 'api', key: '   ' }, settings()), /API key must not be empty/);
    assert.throws(() => credentials({ type: 'api' }, settings()), /API key must be a string/);
  });
});

describe('5. Config preserves user override', () => {
  it('does not overwrite existing config.provider["gemini-web"]', async () => {
    const plugin = await GeminiWebPlugin({}, { baseURL: 'http://127.0.0.1:8083/v1' });
    const cfg = {
      provider: {
        'gemini-web': { name: 'Custom Name', api: 'http://custom:1234/v1', models: { custom: {} } }
      }
    };
    await plugin.config(cfg);
    assert.equal(cfg.provider['gemini-web'].name, 'Custom Name');
    assert.equal(cfg.provider['gemini-web'].api, 'http://custom:1234/v1');
  });
});

describe('6. Logged out loader returns {}', () => {
  it('returns empty object when getAuth returns null or non-api', async () => {
    const plugin = await GeminiWebPlugin({});
    const res1 = await plugin.auth.loader(async () => null);
    assert.deepEqual(res1, {});

    const res2 = await plugin.auth.loader(async () => ({ type: 'oauth' }));
    assert.deepEqual(res2, {});
  });
});

describe('7. API prompt default validation', () => {
  it('validates blank or valid URL and returns error string for invalid', async () => {
    const plugin = await GeminiWebPlugin({});
    const validate = plugin.auth.methods.find(m => m.type === 'api').prompts[0].validate;

    assert.equal(validate(''), undefined);
    assert.equal(validate('http://127.0.0.1:8083/v1'), undefined);
    assert.equal(validate('http://127.0.0.1:8083'), undefined);
    const err = validate('ftp://invalid');
    assert.equal(typeof err, 'string');
    assert.match(err, /protocol must be HTTP or HTTPS/);
  });

  it('authorize persists the resolved baseURL when the prompt is left blank', async () => {
    const plugin = await GeminiWebPlugin({}, { baseURL: 'http://127.0.0.1:9000' });
    const authorize = plugin.auth.methods.find(m => m.type === 'api').authorize;

    assert.deepEqual(await authorize({ baseURL: '' }), {
      type: 'success',
      metadata: { baseURL: 'http://127.0.0.1:9000/v1' }
    });
    assert.deepEqual(await authorize({}), {
      type: 'success',
      metadata: { baseURL: 'http://127.0.0.1:9000/v1' }
    });
    assert.deepEqual(await authorize({ baseURL: 'https://proxy.example.com/' }), {
      type: 'success',
      metadata: { baseURL: 'https://proxy.example.com/v1' }
    });
  });

  it('lets Magpie collect the backend API key after asking for the URL', async () => {
    const plugin = await GeminiWebPlugin({ magpie: {} }, { baseURL: 'http://127.0.0.1:9000' });
    const method = plugin.auth.methods.find(m => m.type === 'api');

    assert.equal(method.prompts, undefined);
    assert.equal((await method.ask({})).key, 'baseURL');
    assert.equal(await method.ask({ baseURL: '' }), null);
    assert.deepEqual(await method.authorize({ baseURL: '' }), {
      type: 'success',
      metadata: { baseURL: 'http://127.0.0.1:9000/v1' }
    });
    await assert.rejects(method.authorize({ baseURL: 'ftp://invalid' }), /protocol must be HTTP or HTTPS/);
  });
});

describe('8. Dynamic model list dedup/media exclusion/empty/malformed 401 expired vs 429/403 not expired', () => {
  let server;
  let serverPort;
  let serverHandler;

  before(async () => {
    server = http.createServer((req, res) => serverHandler(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    }));
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('filters models, deduplicates, excludes media special models', async () => {
    serverHandler = (req, res) => {
      assert.equal(req.url, '/v1/models');
      assert.equal(req.headers['authorization'], 'Bearer test_key');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'gemini-2.5-flash', object: 'model' },
          { id: 'gemini-2.5-flash', object: 'model' },
          { id: 'gemini-2.5-flash-image', object: 'model' },
          { id: 'gemini-canvas-pro', object: 'model' },
          { id: 'gemini-research-agent', object: 'model' },
          { id: 'gpt-4o', object: 'model' },
          { id: 'gemini-3.1-pro', object: 'model' }
        ]
      }));
    };

    const c = { key: 'test_key', baseURL: `http://127.0.0.1:${serverPort}/v1` };
    const opts = settings();
    const models = await listModels(c, opts);

    assert.deepEqual(Object.keys(models), ['gemini-2.5-flash', 'gemini-3.1-pro']);
    assert.equal(models['gemini-2.5-flash'].id, 'gemini-2.5-flash');
    assert.equal(models['gemini-2.5-flash'].name, 'gemini-2.5-flash');
    assert.equal(models['gemini-2.5-flash'].cost.input, 0);
  });

  it('throws error when no usable Gemini models are returned', async () => {
    serverHandler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'gemini-video-preview' }]
      }));
    };

    const c = { key: 'test_key', baseURL: `http://127.0.0.1:${serverPort}/v1` };
    await assert.rejects(
      async () => listModels(c, settings()),
      /No usable Gemini models found/
    );
  });

  it('throws error on malformed model response', async () => {
    serverHandler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'error', data: 'not an array' }));
    };

    const c = { key: 'test_key', baseURL: `http://127.0.0.1:${serverPort}/v1` };
    await assert.rejects(
      async () => listModels(c, settings()),
      /expected data array/
    );
  });

  it('sets signIn=expired ONLY on HTTP 401', async () => {
    serverHandler = (req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    };
    const c = { key: 'test_key', baseURL: `http://127.0.0.1:${serverPort}/v1` };
    try {
      await listModels(c, settings());
      assert.fail('should reject');
    } catch (err) {
      assert.equal(err.status, 401);
      assert.equal(err.signIn, 'expired');
    }
  });

  it('does NOT set signIn=expired on HTTP 429 or 403', async () => {
    const c = { key: 'test_key', baseURL: `http://127.0.0.1:${serverPort}/v1` };

    serverHandler = (req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate limited' }));
    };
    try {
      await listModels(c, settings());
      assert.fail('should reject');
    } catch (err) {
      assert.equal(err.status, 429);
      assert.equal(err.signIn, undefined);
    }

    serverHandler = (req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
    };
    try {
      await listModels(c, settings());
      assert.fail('should reject');
    } catch (err) {
      assert.equal(err.status, 403);
      assert.equal(err.signIn, undefined);
    }
  });
});

describe('9. Conservative tool+image caps toggled & OpenCode Model shape', () => {
  let server;
  let serverPort;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'gemini-2.5-flash', object: 'model' }]
      }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    }));
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('reports conservative capabilities when tool and image flags disabled', async () => {
    const c = { key: 'test_key', baseURL: `http://127.0.0.1:${serverPort}/v1` };
    const opts = settings({ allowTools: false, allowImages: false });
    const models = await listModels(c, opts);
    const m = models['gemini-2.5-flash'];

    assert.equal(m.capabilities.toolcall, false);
    assert.equal(m.capabilities.attachment, false);
    assert.deepEqual(m.capabilities.input, { text: true, image: false });
    assert.deepEqual(m.capabilities.output, { text: true });
    assert.equal(m.capabilities.reasoning, true);
    assert.equal(m.capabilities.temperature, false);
    assert.equal(m.status, 'active');
  });

  it('reports enabled capabilities when tool and image flags enabled', async () => {
    const c = { key: 'test_key', baseURL: `http://127.0.0.1:${serverPort}/v1` };
    const opts = settings({ allowTools: true, allowImages: true });
    const models = await listModels(c, opts);
    const m = models['gemini-2.5-flash'];

    assert.equal(m.capabilities.toolcall, true);
    assert.equal(m.capabilities.attachment, true);
    assert.deepEqual(m.capabilities.input, { text: true, image: true });
    assert.deepEqual(m.capabilities.output, { text: true });
    assert.equal(m.capabilities.reasoning, true);
  });
});

describe('10. Per-account models isolation', () => {
  let server1, serverPort1;
  let server2, serverPort2;

  before(async () => {
    server1 = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'gemini-2.5-flash' }]
      }));
    });
    await new Promise(resolve => server1.listen(0, '127.0.0.1', () => {
      serverPort1 = server1.address().port;
      resolve();
    }));

    server2 = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'gemini-3.1-pro' }]
      }));
    });
    await new Promise(resolve => server2.listen(0, '127.0.0.1', () => {
      serverPort2 = server2.address().port;
      resolve();
    }));
  });

  after(async () => {
    await Promise.all([
      new Promise(resolve => server1.close(resolve)),
      new Promise(resolve => server2.close(resolve))
    ]);
  });

  it('sets m.api.url and discovers models without cross-account contamination', async () => {
    const account1 = { key: 'key1', baseURL: `http://127.0.0.1:${serverPort1}/v1` };
    const account2 = { key: 'key2', baseURL: `http://127.0.0.1:${serverPort2}/v1` };
    const opts = settings();

    const models1 = await listModels(account1, opts);
    const models2 = await listModels(account2, opts);

    assert.deepEqual(Object.keys(models1), ['gemini-2.5-flash']);
    assert.equal(models1['gemini-2.5-flash'].api.url, `http://127.0.0.1:${serverPort1}/v1`);

    assert.deepEqual(Object.keys(models2), ['gemini-3.1-pro']);
    assert.equal(models2['gemini-3.1-pro'].api.url, `http://127.0.0.1:${serverPort2}/v1`);

    // Plugin provider.models hook per-account check
    const plugin = await GeminiWebPlugin({}, opts);
    const reported1 = await plugin.provider.models({}, {
      auth: { type: 'api', key: 'key1', metadata: { baseURL: `http://127.0.0.1:${serverPort1}/v1` } }
    });
    const reported2 = await plugin.provider.models({}, {
      auth: { type: 'api', key: 'key2', metadata: { baseURL: `http://127.0.0.1:${serverPort2}/v1` } }
    });

    assert.deepEqual(Object.keys(reported1), ['gemini-2.5-flash']);
    assert.equal(reported1['gemini-2.5-flash'].api.url, `http://127.0.0.1:${serverPort1}/v1`);

    assert.deepEqual(Object.keys(reported2), ['gemini-3.1-pro']);
    assert.equal(reported2['gemini-3.1-pro'].api.url, `http://127.0.0.1:${serverPort2}/v1`);
  });
});

describe('11-21. Forwarding, security stripping, tool/image validation, and streaming', () => {
  let server;
  let serverPort;
  let serverHandler;

  before(async () => {
    server = http.createServer((req, res) => serverHandler(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    }));
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('11. Request input+init honored', async () => {
    serverHandler = (req, res) => {
      assert.equal(req.headers['accept'], 'application/json');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });
    const opts = settings({ baseURL });

    // Construct actual Request with initial headers, then pass init override
    const initialReq = new Request(`${baseURL}/models`, {
      method: 'GET',
      headers: { 'Accept': 'text/plain' }
    });

    const res = await forward(initialReq, {
      headers: { 'Accept': 'application/json' }
    }, getAuth, opts);
    assert.equal(res.status, 200);
  });

  it('12. Exact body preservation', async () => {
    const rawPayload = JSON.stringify({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hello world' }],
      temperature: 0.7,
      stream: true
    });

    let receivedBody = '';
    serverHandler = async (req, res) => {
      for await (const chunk of req) receivedBody += chunk;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-1' }));
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });
    const opts = settings({ baseURL });

    await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawPayload
    }, getAuth, opts);

    assert.equal(receivedBody, rawPayload);
  });

  it('13. Fresh auth per call', async () => {
    let callCount = 0;
    const keysUsed = [];
    serverHandler = (req, res) => {
      keysUsed.push(req.headers['authorization']);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => {
      callCount++;
      return { type: 'api', key: `key_call_${callCount}`, metadata: { baseURL } };
    };
    const opts = settings({ baseURL });

    await forward(`${baseURL}/models`, { method: 'GET' }, getAuth, opts);
    await forward(`${baseURL}/models`, { method: 'GET' }, getAuth, opts);

    assert.deepEqual(keysUsed, ['Bearer key_call_1', 'Bearer key_call_2']);
  });

  it('14. Caller auth+cookie stripped', async () => {
    let capturedHeaders;
    serverHandler = (req, res) => {
      capturedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'backend_key', metadata: { baseURL } });
    const opts = settings({ baseURL });

    await forward(`${baseURL}/models`, {
      method: 'GET',
      headers: {
        'Cookie': 'user_session=secret; GoogleCookie=secret',
        'Authorization': 'Bearer caller_secret_token',
        'x-api-key': 'caller_api_key',
        'anthropic-version': '2023-06-01',
        'x-magpie-key': 'internal_key',
        'Accept': 'application/json'
      }
    }, getAuth, opts);

    assert.equal(capturedHeaders['authorization'], 'Bearer backend_key');
    assert.equal(capturedHeaders['cookie'], undefined);
    assert.equal(capturedHeaders['x-api-key'], undefined);
    assert.equal(capturedHeaders['anthropic-version'], undefined);
    assert.equal(capturedHeaders['x-magpie-key'], undefined);
  });

  it('15. Foreign endpoint and redirect target never receive auth', async () => {
    let serverHit = false;
    serverHandler = () => { serverHit = true; };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'secret_key', metadata: { baseURL } });
    const opts = settings({ baseURL });

    // Cross-origin / foreign URL
    const res = await forward('https://evil.attacker.com/v1/models', { method: 'GET' }, getAuth, opts);
    assert.equal(res.status, 404);
    assert.equal(serverHit, false);

    // Redirect attempt from backend
    serverHandler = (req, res) => {
      res.writeHead(302, { 'Location': 'https://evil.attacker.com/leak' });
      res.end();
    };
    const resRedirect = await forward(`${baseURL}/models`, { method: 'GET' }, getAuth, opts);
    assert.equal(resRedirect.status, 502);
  });

  it('16. Upstream 401/429 status, retry-after preserved, and content-encoding stripped', async () => {
    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });
    const opts = settings({ baseURL });

    // 401 adds X-Magpie-Sign-In: expired
    serverHandler = (req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    };
    const res401 = await forward(`${baseURL}/models`, { method: 'GET' }, getAuth, opts);
    assert.equal(res401.status, 401);
    assert.equal(res401.headers.get('x-magpie-sign-in'), 'expired');

    // 429 preserves Retry-After
    serverHandler = (req, res) => {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '120'
      });
      res.end(JSON.stringify({ error: 'rate limited' }));
    };
    const res429 = await forward(`${baseURL}/models`, { method: 'GET' }, getAuth, opts);
    assert.equal(res429.status, 429);
    assert.equal(res429.headers.get('retry-after'), '120');

    // Gzip compressed upstream response: decoded body readable and headers deleted
    serverHandler = (req, res) => {
      const gzipped = zlib.gzipSync(Buffer.from(JSON.stringify({ status: 'ok', compressed: true })));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': gzipped.length.toString()
      });
      res.end(gzipped);
    };

    const resGzip = await forward(`${baseURL}/models`, { method: 'GET' }, getAuth, opts);
    assert.equal(resGzip.status, 200);
    assert.equal(resGzip.headers.get('content-encoding'), null);
    assert.equal(resGzip.headers.get('content-length'), null);
    const parsedGzip = await resGzip.json();
    assert.deepEqual(parsedGzip, { status: 'ok', compressed: true });
  });

  it('17. Tools disabled failure returns 400 without fetch vs opt-in pass', async () => {
    let fetched = false;
    serverHandler = (req, res) => {
      fetched = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });

    // allowTools: false -> reject with 400
    const optsDisabled = settings({ baseURL, allowTools: false });
    const resDisabled = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'test' }],
        tools: [{ type: 'function', function: { name: 'get_weather' } }]
      })
    }, getAuth, optsDisabled);

    assert.equal(resDisabled.status, 400);
    assert.equal(fetched, false);
    const jsonErr = await resDisabled.json();
    assert.match(jsonErr.error.message, /Tool calls are turned off.*magpie plugin options magpie-gemini-web '\{"allowTools":true\}'/);

    // allowTools: true -> passes
    const optsEnabled = settings({ baseURL, allowTools: true });
    const resEnabled = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'test' }],
        tools: [{ type: 'function', function: { name: 'get_weather' } }]
      })
    }, getAuth, optsEnabled);

    assert.equal(resEnabled.status, 200);
    assert.equal(fetched, true);
  });

  it('18. Images disabled returns 400 without fetch vs opt-in pass & media narrowness', async () => {
    let fetched = false;
    serverHandler = (req, res) => {
      fetched = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });

    // allowImages: false -> reject image_url
    const optsDisabled = settings({ baseURL, allowImages: false });
    const resDisabled = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
          ]
        }]
      })
    }, getAuth, optsDisabled);

    assert.equal(resDisabled.status, 400);
    assert.equal(fetched, false);
    const jsonErr = await resDisabled.json();
    assert.match(jsonErr.error.message, /Image input is turned off.*magpie plugin options magpie-gemini-web '\{"allowImages":true\}'/);

    // allowImages: true -> passes with valid image_url
    const optsEnabled = settings({ baseURL, allowImages: true });
    const resEnabled = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
          ]
        }]
      })
    }, getAuth, optsEnabled);

    assert.equal(resEnabled.status, 200);
    assert.equal(fetched, true);

    // Media narrowness: reject unsupported types even when allowImages is true
    fetched = false;
    const resAudio = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: 'abc' } }]
        }]
      })
    }, getAuth, optsEnabled);
    assert.equal(resAudio.status, 400);
    assert.equal(fetched, false);
    const audioErr = await resAudio.json();
    assert.match(audioErr.error.message, /Unsupported content type/);

    // Reject malformed image_url (missing url or empty string)
    const resBadImage = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: '   ' } }]
        }]
      })
    }, getAuth, optsEnabled);
    assert.equal(resBadImage.status, 400);
    const badImgErr = await resBadImage.json();
    assert.match(badImgErr.error.message, /Image content must contain an image_url URL/);

    // Reject malformed text part (text property not string)
    const resBadText = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 12345 }]
        }]
      })
    }, getAuth, optsEnabled);
    assert.equal(resBadText.status, 400);
    const badTextErr = await resBadText.json();
    assert.match(badTextErr.error.message, /Text content must contain a text string/);
  });

  it('19. SSE first chunk available before upstream closes + model not rewritten + DONE unchanged', async () => {
    let closeServerRes;
    serverHandler = (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write('data: {"id":"chatcmpl-1","model":"gemini-2.5-flash","choices":[{"delta":{"content":"Hello"}}]}\n\n');
      closeServerRes = () => {
        res.write('data: [DONE]\n\n');
        res.end();
      };
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });
    const opts = settings({ baseURL });

    const res = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    }, getAuth, opts);

    assert.equal(res.status, 200);
    const reader = res.body.getReader();

    // First chunk can be read BEFORE upstream closes
    const firstChunk = await reader.read();
    const text1 = new TextDecoder().decode(firstChunk.value);
    assert.match(text1, /gemini-2.5-flash/);
    assert.match(text1, /Hello/);

    // Now close upstream
    closeServerRes();
    const secondChunk = await reader.read();
    const text2 = new TextDecoder().decode(secondChunk.value);
    assert.match(text2, /\[DONE\]/);
  });

  it('20. Caller abort closes upstream', async () => {
    let clientCloseResolve;
    const clientClosePromise = new Promise(resolve => {
      clientCloseResolve = resolve;
    });

    serverHandler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: chunk1\n\n');
      res.on('close', () => {
        clientCloseResolve();
      });
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });
    const opts = settings({ baseURL });

    const controller = new AbortController();
    const res = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      signal: controller.signal
    }, getAuth, opts);

    const reader = res.body.getReader();
    const firstChunk = await reader.read();
    assert.ok(firstChunk.value);

    // Abort from caller
    controller.abort();

    try {
      await reader.read();
    } catch {}

    const closed = await Promise.race([
      clientClosePromise.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 2000))
    ]);
    assert.equal(closed, true, 'Upstream server connection should close upon caller abort');
  });

  it('21. Finite timeout with 502/504', async () => {
    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });

    // Timeout (504)
    serverHandler = () => {
      // intentionally hang
    };
    const optsTimeout = settings({ baseURL, requestTimeoutMs: 50 });
    const res504 = await forward(`${baseURL}/models`, { method: 'GET' }, getAuth, optsTimeout);
    assert.equal(res504.status, 504);
    const body504 = await res504.json();
    assert.equal(body504.error.code, 'gateway_timeout');

    // Connection refused (502)
    const unreachableBase = 'http://127.0.0.1:54321/v1';
    const opts502 = settings({ baseURL: unreachableBase });
    const res502 = await forward(`${unreachableBase}/models`, { method: 'GET' }, async () => ({
      type: 'api',
      key: 'key',
      metadata: { baseURL: unreachableBase }
    }), opts502);
    assert.equal(res502.status, 502);
    const body502 = await res502.json();
    assert.equal(body502.error.code, 'bad_gateway');
  });

  it('21. A streamed reply longer than requestTimeoutMs runs to the end while pieces keep coming', async () => {
    serverHandler = (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        let n = 0;
        const tick = setInterval(() => {
          res.write(`data: {"choices":[{"index":0,"delta":{"content":"${n}"}}]}\n\n`);
          if (++n === 8) {
            clearInterval(tick);
            res.end('data: [DONE]\n\n');
          }
        }, 60);
      });
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });
    const opts = settings({ baseURL, requestTimeoutMs: 200 });

    const started = Date.now();
    const res = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] })
    }, getAuth, opts);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(Date.now() - started > 400, 'the reply must outlast requestTimeoutMs');
    for (let n = 0; n < 8; n++) assert.match(text, new RegExp(`"content":"${n}"`));
    assert.match(text, /\[DONE\]/);
  });

  it('21. A reply that goes quiet for requestTimeoutMs is cut off', async () => {
    let upstreamClosed;
    const closed = new Promise(resolve => { upstreamClosed = resolve; });
    serverHandler = (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"index":0,"delta":{"content":"first"}}]}\n\n');
        res.on('close', upstreamClosed);
      });
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });
    const opts = settings({ baseURL, requestTimeoutMs: 150 });

    const res = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] })
    }, getAuth, opts);
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
    await assert.rejects(async () => {
      for (;;) if ((await reader.read()).done) break;
    }, err => err.name === 'TimeoutError' && /sent nothing for 150 ms/.test(err.message));
    await closed;
  });
});

describe('22. Reasoning effort maps onto the backend -thinking twin', () => {
  let server;
  let serverPort;
  let modelIds;
  let modelsStatus;
  let modelsCalls;
  let chatModels;

  before(async () => {
    server = http.createServer(async (req, res) => {
      if (req.url === '/v1/models') {
        modelsCalls++;
        res.writeHead(modelsStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: modelIds.map(id => ({ id, object: 'model' })) }));
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      chatModels.push(JSON.parse(raw).model);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-1' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    }));
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  const reset = () => {
    modelIds = ['gemini-4-argon', 'gemini-4-argon-thinking-medium', 'gemini-4-argon-thinking', 'gemini-3.6-flash', 'gemini-3.6-flash-thinking', 'gemini-canvas', 'gemini-solo', 'gemini-lone-thinking'];
    modelsStatus = 200;
    modelsCalls = 0;
    chatModels = [];
  };

  const send = (key, body) => {
    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    return forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...body })
    }, async () => ({ type: 'api', key, metadata: { baseURL } }), settings({ baseURL }));
  };

  it('declares low/medium/high variants on base models with thinking twins, and hides the twins', async () => {
    reset();
    const c = { key: 'variants_key', baseURL: `http://127.0.0.1:${serverPort}/v1` };
    const models = await listModels(c, settings({ baseURL: c.baseURL }));

    assert.deepEqual(models['gemini-4-argon'].variants, { low: {}, medium: {}, high: {} });
    assert.deepEqual(models['gemini-3.6-flash'].variants, { low: {}, high: {} });
    assert.equal(models['gemini-4-argon-thinking-medium'], undefined);
    assert.equal(models['gemini-4-argon-thinking'], undefined);
    assert.equal(models['gemini-3.6-flash-thinking'], undefined);
    assert.deepEqual(models['gemini-solo'].variants, {});
    assert.deepEqual(models['gemini-lone-thinking'].variants, {}, 'a twin with no base stays');
    assert.equal(models['gemini-canvas'], undefined);
  });

  it('routes medium to -thinking-medium when available, high and other non-low efforts to -thinking, low/none/absent to the base', async () => {
    reset();
    const cases = [
      [{ model: 'gemini-4-argon', reasoning_effort: 'high' }, 'gemini-4-argon-thinking'],
      [{ model: 'gemini-4-argon', reasoning_effort: 'medium' }, 'gemini-4-argon-thinking-medium'],
      [{ model: 'gemini-4-argon', reasoning_effort: 'xhigh' }, 'gemini-4-argon-thinking'],
      [{ model: 'gemini-3.6-flash', reasoning_effort: 'medium' }, 'gemini-3.6-flash-thinking'],
      [{ model: 'gemini-3.6-flash', reasoning_effort: 'high' }, 'gemini-3.6-flash-thinking'],
      [{ model: 'gemini-4-argon', reasoning_effort: 'low' }, 'gemini-4-argon'],
      [{ model: 'gemini-4-argon', reasoning_effort: 'minimal' }, 'gemini-4-argon'],
      [{ model: 'gemini-4-argon', reasoning_effort: 'none' }, 'gemini-4-argon'],
      [{ model: 'gemini-4-argon' }, 'gemini-4-argon'],
      [{ model: 'gemini-4-argon-thinking', reasoning_effort: 'low' }, 'gemini-4-argon-thinking'],
      [{ model: 'gemini-4-argon-thinking-medium', reasoning_effort: 'low' }, 'gemini-4-argon-thinking-medium'],
      [{ model: 'gemini-solo', reasoning_effort: 'high' }, 'gemini-solo']
    ];
    for (const [body] of cases) {
      const res = await send('route_key', body);
      assert.equal(res.status, 200);
    }
    assert.deepEqual(chatModels, cases.map(([, want]) => want));
    assert.equal(modelsCalls, 1, 'model list fetched once and cached');
  });

  it('keeps the exact body when no twin applies', async () => {
    reset();
    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const raw = '{"model":"gemini-4-argon","reasoning_effort":"low","messages":[{"role":"user","content":"hi"}]}';
    let received;
    const original = server.listeners('request')[0];
    server.removeAllListeners('request');
    server.on('request', async (req, res) => {
      received = '';
      for await (const chunk of req) received += chunk;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    try {
      await forward(`${baseURL}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw },
        async () => ({ type: 'api', key: 'exact_key', metadata: { baseURL } }), settings({ baseURL }));
    } finally {
      server.removeAllListeners('request');
      server.on('request', original);
    }
    assert.equal(received, raw);
  });

  it('sends the request unchanged when the model list cannot be fetched', async () => {
    reset();
    modelsStatus = 500;
    const res = await send('broken_models_key', { model: 'gemini-4-argon', reasoning_effort: 'high' });
    assert.equal(res.status, 200);
    assert.deepEqual(chatModels, ['gemini-4-argon']);
  });
});

describe('23. Plugin metadata for Magpie', () => {
  it('declares a valid base64 SVG data URI in package.json and both provider auth hooks', async () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.magpie?.icon, PLUGIN_ICON);
    assert.match(PLUGIN_ICON, /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/);

    const svg = Buffer.from(PLUGIN_ICON.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
    assert.match(svg, /^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>[\s\S]*<\/svg>$/);

    const web = await GeminiWebPlugin();
    const studio = await AIStudioPlugin();
    assert.equal(web.auth.icon, PLUGIN_ICON);
    assert.equal(studio.auth.icon, PLUGIN_ICON);
  });

  it('lets each Gemini Web sign-in take two requests at once and AI Studio one', async () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.magpie?.maxConcurrency, 2);

    const web = await GeminiWebPlugin();
    const studio = await AIStudioPlugin();
    assert.equal(web.auth.maxConcurrency, 2);
    assert.equal(studio.auth.maxConcurrency, 1);
  });
});

describe('24. Plugin entry lists Carbon and Argon tiers offline', () => {
  let server;
  let serverPort;
  let seen;

  before(async () => {
    seen = [];
    const ids = [
      'gemini-4-carbon', 'gemini-4-carbon-thinking-medium', 'gemini-4-carbon-thinking',
      'gemini-4-argon', 'gemini-4-argon-thinking-medium', 'gemini-4-argon-thinking',
      'gemini-3.5-flash-lite'
    ];
    server = http.createServer(async (req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: ids.map(id => ({ id, object: 'model' })) }));
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      seen.push(JSON.parse(raw).model);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-offline' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    }));
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('exposes low/medium/high for both families and rewrites high without leaving the family', async () => {
    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const auth = { type: 'api', key: 'offline-carbon-key', metadata: { baseURL } };
    const plugin = await GeminiWebPlugin({}, { baseURL });
    const models = await plugin.provider.models({}, { auth });
    assert.deepEqual(models['gemini-4-carbon'].variants, { low: {}, medium: {}, high: {} });
    assert.deepEqual(models['gemini-4-argon'].variants, { low: {}, medium: {}, high: {} });
    assert.deepEqual(models['gemini-3.5-flash-lite'].variants, {});
    assert.equal(models['gemini-4-carbon-thinking'], undefined);
    assert.equal(models['gemini-4-argon-thinking'], undefined);

    const loaded = await plugin.auth.loader(async () => auth);
    const send = body => loaded.fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...body })
    });
    for (const body of [
      { model: 'gemini-4-carbon', reasoning_effort: 'high' },
      { model: 'gemini-4-carbon', reasoning_effort: 'medium' },
      { model: 'gemini-4-argon', reasoning_effort: 'high' },
      { model: 'gemini-3.5-flash-lite', reasoning_effort: 'high' }
    ]) {
      assert.equal((await send(body)).status, 200);
    }
    assert.deepEqual(seen, [
      'gemini-4-carbon-thinking',
      'gemini-4-carbon-thinking-medium',
      'gemini-4-argon-thinking',
      'gemini-3.5-flash-lite'
    ]);
  });
});

describe('25. Gemini Web native protocol through the auth loader', () => {
  const model = 'gemini-4-carbon';
  const medium = `${model}-thinking-medium`;
  const high = `${model}-thinking`;
  const text = { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] };
  const nativeJSON = '{ "candidates": [{"content":{"parts":[{"text":"native [cite: 1]"}]}}], "usageMetadata":{"totalTokenCount":5} }\n';
  const firstFrame = `data: ${nativeJSON.trim()}\r\n\r\n`;
  const lastFrame = 'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":8}}\r\n\r\n';
  const chatJSON = '{"choices":[{"message":{"content":"chat [cite: 1]"}}],"usage":{"total_tokens":5}}';
  const errorJSON = '{ "error": {"code": 400, "message": "native error", "details": [{"reason":"API_KEY_INVALID"}]} }\n';
  let server, origin, baseURL, plugin, seen, releaseStream;
  const catalogReplies = new Map();
  const authFor = (key = 'native-test-a') => ({ type: 'api', key, metadata: { baseURL } });
  const url = (action = 'streamGenerateContent', id = model, version = 'v1') =>
    `${origin}/edge/${version}/models/${id}:${action}`;
  const post = (loader, target, body = text, init = {}) => loader.fetch(target, {
    method: 'POST',
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });

  before(async () => {
    seen = [];
    server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ url: req.url, headers: req.headers, raw });
      if (req.url === '/edge/v1/models' || req.url === '/v1/models') {
        const reply = catalogReplies.get(req.headers.authorization);
        if (reply) return reply(res);
        const ids = req.headers.authorization === 'Bearer native-test-b'
          ? [model, 'gemini-account-b']
          : [model, medium, high, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-image', 'not-gemini'];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: ids.map(id => ({ id })) }));
      } else if (req.url === '/edge/v1/chat/completions' || req.url === '/v1/chat/completions') {
        res.setHeader('content-type', 'application/json');
        res.end(chatJSON);
      } else if (req.url.endsWith(':countTokens')) {
        res.setHeader('content-type', 'application/json');
        res.end('{"totalTokens":5}\n');
      } else if (req.url.startsWith('/v1/models/') && req.url.endsWith(':generateContent')) {
        const prompt = body.contents[0].parts[0].text;
        if (prompt === 'recover') {
          res.setHeader('content-type', 'application/json');
          res.end(nativeJSON);
          return;
        }
        const status = Number(prompt);
        const headers = { 'content-type': 'application/json', [UNREACHABLE_HEADER]: 'unreachable' };
        if (status === 429) headers['retry-after'] = '37';
        if (status === 401) headers['x-magpie-sign-in'] = 'kept';
        res.writeHead(status, headers);
        res.end(errorJSON);
      } else if (body?.contents?.[0]?.parts?.[0]?.text === 'upstream error') {
        res.writeHead(400, { 'content-type': 'application/json', 'retry-after': '7', 'x-magpie-sign-in': 'kept' });
        res.end(errorJSON);
      } else if (body?.contents?.[0]?.parts?.[0]?.text === 'redirect') {
        res.writeHead(307, { location: '/different-service' });
        res.end();
      } else if (req.url.endsWith('?alt=sse')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' });
        res.write(firstFrame);
        if (body?.contents?.[0]?.parts?.[0]?.text === 'hold') {
          await new Promise(resolve => {
            releaseStream = resolve;
            res.once('close', resolve);
          });
        }
        res.end(lastFrame);
      } else if (req.url.endsWith(':streamGenerateContent')) {
        res.setHeader('content-type', 'application/json');
        res.end(`[${nativeJSON.trim()}]\n`);
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(nativeJSON);
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    baseURL = `${origin}/edge/v1`;
    plugin = await GeminiWebPlugin({});
  });

  after(async () => {
    releaseStream?.();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  it('advertises Gemini and Chat on the same text model with its existing capabilities and tiers', async () => {
    const models = await plugin.provider.models({}, { auth: authFor() });
    assert.deepEqual(Object.keys(models), [model, 'gemini-3.5-flash-lite']);
    assert.deepEqual(models[model].api, { id: model, url: baseURL, npm: '@ai-sdk/google' });
    assert.deepEqual(models[model].also, ['@ai-sdk/openai-compatible']);
    assert.deepEqual(Object.keys(models[model].variants), ['low', 'medium', 'high']);
    const loader = await plugin.auth.loader(async () => authFor());
    const res = await post(loader, `${baseURL}/chat/completions`, {
      model, reasoning_effort: 'medium', messages: [{ role: 'user', content: 'ping' }]
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { choices: [{ message: { content: 'chat' } }], usage: { total_tokens: 5 } });
    assert.equal(JSON.parse(seen.at(-1).raw).model, medium);
  });

  it('forwards a full AGY-shaped /v1 SSE request and yields the first native chunk before completion', async () => {
    const loader = await plugin.auth.loader(async () => authFor('native-test-cold'));
    const body = {
      model: `models/${model}`,
      contents: [
        { role: 'user', parts: [{ text: 'hold' }, { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] },
        { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'read', args: { path: '/tmp/test' } }, thoughtSignature: 'YWJj' }] },
        { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'read', response: { result: 'test' } } }] }
      ],
      systemInstruction: { parts: [{ text: 'Keep bytes: "\\": }' }] },
      tools: [{ functionDeclarations: [{ name: 'read', parametersJsonSchema: { type: 'object' } }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read'] } },
      safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
      generationConfig: { maxOutputTokens: 100, responseModalities: ['TEXT'], thinkingConfig: { includeThoughts: true } }
    };
    const raw = JSON.stringify(body, null, 2).replace('"path":', '"offset": 9007199254740993, "path":');
    const start = seen.length;
    const res = await post(loader, `${url()}?alt=sse`, raw, {
      headers: {
        accept: 'text/event-stream', authorization: 'Bearer caller', cookie: 'caller=value',
        'x-goog-api-key': 'caller', 'x-goog-user-project': 'caller', 'x-magpie-effort': 'HIGH'
      }
    });
    try {
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-accel-buffering'), 'no');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let received = '';
      while (received.length < firstFrame.length) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        received += decoder.decode(chunk.value, { stream: true });
      }
      assert.equal(received, firstFrame);
      assert.deepEqual(seen.slice(start).map(r => r.url), ['/edge/v1/models', `/edge/v1/models/${high}:streamGenerateContent?alt=sse`]);
      assert.equal(seen.at(-1).raw, raw);
      const headers = seen.at(-1).headers;
      assert.equal(headers.authorization, 'Bearer native-test-cold');
      for (const name of ['cookie', 'x-goog-api-key', 'x-goog-user-project', 'x-magpie-effort']) assert.equal(headers[name], undefined);
      releaseStream();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      assert.equal(received + decoder.decode(), firstFrame + lastFrame);
    } finally {
      releaseStream?.();
    }
  });

  it('preserves prefixed v1beta, native JSON, countTokens and upstream errors', async () => {
    const loader = await plugin.auth.loader(async () => authFor());
    for (const [action, body, expected] of [
      ['generateContent', text, nativeJSON],
      ['streamGenerateContent', text, `[${nativeJSON.trim()}]\n`],
      ['countTokens', { generateContentRequest: { model: `models/${model}`, ...text } }, '{"totalTokens":5}\n']
    ]) {
      const res = await post(loader, url(action, model, 'v1beta'), body);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), expected);
      assert.equal(seen.at(-1).url, `/edge/v1beta/models/${model}:${action}`);
    }
    assert.deepEqual(JSON.parse(seen.at(-1).raw).contents, text.contents);
    const res = await post(loader, url('generateContent'), { contents: [{ parts: [{ text: 'upstream error' }] }] });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('retry-after'), '7');
    assert.equal(res.headers.get('x-magpie-sign-in'), 'kept');
    assert.equal(await res.text(), errorJSON);
  });

  it('uses host effort before native level and budget, and scopes twins to the current bearer', async () => {
    let auth = authFor();
    const loader = await plugin.auth.loader(async () => auth);
    for (const [thinkingConfig, header, expected] of [
      [{ includeThoughts: true }, undefined, model],
      [{ thinkingBudget: 0, includeThoughts: true }, undefined, model],
      [{ thinkingBudget: 4096 }, undefined, model],
      [{ thinkingBudget: 4097 }, undefined, medium],
      [{ thinkingBudget: 12000 }, undefined, medium],
      [{ thinkingBudget: 12001 }, undefined, high],
      [{ thinkingBudget: -1 }, undefined, medium],
      [{ thinkingLevel: 'MEDIUM', thinkingBudget: 24000 }, undefined, medium],
      [{ thinkingLevel: 'HIGH' }, 'minimal', model]
    ]) {
      const res = await post(loader, url('generateContent'), { ...text, generationConfig: { thinkingConfig } }, {
        headers: header ? { 'x-magpie-effort': header } : {}
      });
      assert.equal(res.status, 200);
      await res.body.cancel();
      assert.equal(seen.at(-1).url, `/edge/v1/models/${expected}:generateContent`);
    }
    const highEffort = { headers: { 'x-magpie-effort': 'high' } };
    let res = await post(loader, url('generateContent', medium), text, highEffort);
    assert.equal(res.status, 200);
    await res.body.cancel();
    assert.equal(seen.at(-1).url, `/edge/v1/models/${medium}:generateContent`);

    auth = authFor('native-test-b');
    res = await post(loader, url('generateContent'), text, highEffort);
    assert.equal(res.status, 200);
    await res.body.cancel();
    assert.equal(seen.at(-1).url, `/edge/v1/models/${model}:generateContent`);
    assert.equal(seen.at(-1).headers.authorization, 'Bearer native-test-b');
    assert.equal((await post(loader, url('countTokens', medium))).status, 404);
    assert.equal((await post(loader, url('countTokens', 'gemini-account-b'))).status, 200);

    auth = { ...authFor(), metadata: { baseURL, mode: 'studio' } };
    const start = seen.length;
    assert.equal((await post(loader, url('generateContent'))).status, 401);
    assert.equal(seen.length, start);
  });

  it('rejects unsupported routes, tools, media and ambiguous JSON before forwarding', async () => {
    const restricted = await GeminiWebPlugin({}, { allowTools: false, allowImages: false });
    const locked = await restricted.auth.loader(async () => authFor('native-test-restricted'));
    const loader = await plugin.auth.loader(async () => authFor());
    const parts = (...parts) => ({ contents: [{ parts }] });
    const image = { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } };
    const start = seen.length;
    for (const body of [
      { ...text, Tools: [{ functionDeclarations: [{ name: 'read' }] }] },
      { ...text, 'toolſ': [{ functionDeclarations: [{ name: 'read' }] }] },
      { ...text, toolConfig: { functionCallingConfig: { mode: 'ANY' } } },
      parts({ FunctionCall: { name: 'read', args: {} } }),
      parts({ function_response: { name: 'read', response: {} } }),
      parts(image),
      { ...text, SystemInstruction: { parts: [image] } },
      { generateContentRequest: parts(image) }
    ]) {
      assert.equal((await post(locked, url('countTokens'), body)).status, 400);
    }
    for (const body of [
      { tools: {} }, { tools: [{ googleSearch: {} }] }, { tools: [{ functionDeclarations: [{}] }] },
      parts({ functionCall: { name: 'read', args: [] } }),
      parts({ executableCode: { language: 'PYTHON', code: 'print(1)' } }),
      parts({ functionResponse: { name: 'read', parts: [image] } }),
      parts({ inlineData: { mimeType: 'image/png', data: 'not base64' } }),
      parts({ inlineData: { mimeType: 'video/mp4', data: 'ZGF0YQ==' } }),
      parts({ fileData: { mimeType: 'image/png', fileUri: `${origin}/admin` } }),
      { ...text, generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } },
      { ...text, model: 'models/gemini-somewhere-else' },
      '{"toolConfig":{"functionCallingConfig":{"mode":"ANY"}},"tool\\u0043onfig":{}}',
      '{"contents":[],"CONTENTS":[]}'
    ]) {
      assert.equal((await post(loader, url('generateContent'), body)).status, 400);
    }
    for (const target of [
      `${url()}?alt=sse&key=caller`, `${url()}?alt=sse&alt=sse`, `${url()}#fragment`,
      `${url('generateContent')}?alt=sse`, `${url('countTokens')}?alt=sse`,
      url('unsupported'), url('generateContent', 'gemini-evil%2fadmin'),
      url('generateContent', 'gemini-3.1-flash-image'), url('generateContent', 'gemini-unknown'),
      url('generateContent').replace('/edge/', '/other/'), url('generateContent').replace('127.0.0.1', 'localhost')
    ]) {
      assert.ok([400, 404].includes((await post(loader, target)).status), target);
    }
    assert.equal((await loader.fetch(url('generateContent'))).status, 400);
    assert.equal(seen.length, start);

    const redirected = await post(loader, url('generateContent'), parts({ text: 'redirect' }));
    assert.equal(redirected.status, 502);
    assert.equal(redirected.headers.get(UNREACHABLE_HEADER), null);
    assert.deepEqual(seen.slice(start).map(r => r.url), [`/edge/v1/models/${model}:generateContent`]);
  });

  it('propagates caller cancellation and a silent-chunk timeout on native SSE', async () => {
    const impatient = await GeminiWebPlugin({}, { requestTimeoutMs: 250 });
    const loader = await impatient.auth.loader(async () => authFor());
    const body = { contents: [{ parts: [{ text: 'hold' }] }] };
    const controller = new AbortController();
    let res = await post(loader, `${url()}?alt=sse`, body, { signal: controller.signal });
    const reader = res.body.getReader();
    assert.equal((await reader.read()).done, false);
    controller.abort();
    await assert.rejects(reader.read(), { name: 'AbortError' });

    res = await post(loader, `${url()}?alt=sse`, body);
    const stalled = res.body.getReader();
    assert.equal((await stalled.read()).done, false);
    await assert.rejects(stalled.read(), { name: 'TimeoutError' });
  });

  it('forwards catalog status and headers after the per-account TTL expires', async () => {
    const keyA = 'native-ttl-a';
    const keyB = 'native-ttl-b';
    let auth = authFor(keyA);
    const loader = await plugin.auth.loader(async () => auth);
    const target = url('generateContent');
    for (const key of [keyA, keyB]) await plugin.provider.models({}, { auth: authFor(key) });
    const reply = (key, status, headers) => catalogReplies.set(`Bearer ${key}`, res => {
      res.writeHead(status, headers);
      res.end();
    });
    reply(keyA, 429, { 'retry-after': '37', 'x-gemini-web-backend': 'unreachable' });
    reply(keyB, 401, { 'x-magpie-sign-in': 'kept' });
    const start = seen.length;
    const warm = await post(loader, target);
    assert.equal(warm.status, 200);
    await warm.text();
    assert.equal(seen.length, start + 1);
    const now = Date.now;
    Date.now = () => now() + 11 * 60 * 1000;
    try {
      let res = await post(loader, target);
      assert.equal(res.status, 429);
      assert.equal(res.headers.get('retry-after'), '37');
      assert.equal(res.headers.get('x-magpie-sign-in'), null);
      assert.equal(res.headers.get(UNREACHABLE_HEADER), null);
      await assert.rejects(plugin.provider.models({}, { auth }), err =>
        err.status === 429 && new Headers(err.headers).get('retry-after') === '37');

      auth = authFor(keyB);
      res = await post(loader, target);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('x-magpie-sign-in'), 'kept');
      await assert.rejects(plugin.provider.models({}, { auth }), { status: 401, signIn: 'kept' });

      reply(keyB, 401, {});
      res = await post(loader, target);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('x-magpie-sign-in'), 'expired');
      assert.deepEqual(seen.slice(start + 1).map(({ url, headers }) => [url, headers.authorization]), [
        ['/edge/v1/models', `Bearer ${keyA}`], ['/edge/v1/models', `Bearer ${keyA}`],
        ['/edge/v1/models', `Bearer ${keyB}`], ['/edge/v1/models', `Bearer ${keyB}`],
        ['/edge/v1/models', `Bearer ${keyB}`]
      ]);
    } finally {
      Date.now = now;
    }
  });

  it('returns 504 for catalog silence before headers and after the first body bytes', async () => {
    const impatient = await GeminiWebPlugin({}, { modelTimeoutMs: 250 });
    const target = url('generateContent');
    for (const afterHeaders of [false, true]) {
      const key = `native-timeout-${afterHeaders}`;
      const hit = seen.length;
      catalogReplies.set(`Bearer ${key}`, res => {
        if (!afterHeaders) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"data":[');
      });
      const loader = await impatient.auth.loader(async () => authFor(key));
      const res = await post(loader, target);
      assert.equal(res.status, 504, `afterHeaders=${afterHeaders}`);
      assert.equal(res.headers.get(UNREACHABLE_HEADER), null);
      assert.deepEqual(seen.slice(hit).map(r => r.url), ['/edge/v1/models']);
    }
  });

  it('propagates caller abort during catalog discovery without dispatching a generation', async () => {
    const reason = new Error('cancel catalog lookup');
    for (const afterHeaders of [false, true]) {
      const key = `native-catalog-abort-${afterHeaders}`;
      const controller = new AbortController();
      const arrived = new Promise(resolve => catalogReplies.set(`Bearer ${key}`, res => {
        if (afterHeaders) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"data":[');
        }
        resolve();
      }));
      const loader = await plugin.auth.loader(async () => authFor(key));
      const hit = seen.length;
      const pending = post(loader, url('generateContent'), text, { signal: controller.signal });
      await Promise.race([arrived, pending.then(() => assert.fail('catalog request never arrived'))]);
      controller.abort(reason);
      await assert.rejects(pending, err => err === reason);
      assert.deepEqual(seen.slice(hit).map(r => r.url), ['/edge/v1/models']);
    }
  });

  it('marks only connection failures in the catalog lookup as eligible for managed recovery', async () => {
    catalogReplies.set('Bearer native-catalog-redirect', res => {
      res.writeHead(307, { location: '/different-service' });
      res.end();
    });
    const hit = seen.length;
    const redirectLoader = await plugin.auth.loader(async () => authFor('native-catalog-redirect'));
    const redirect = await post(redirectLoader, url('generateContent'));
    assert.equal(redirect.status, 502);
    assert.equal(redirect.headers.get(UNREACHABLE_HEADER), null);
    assert.deepEqual(seen.slice(hit).map(r => r.url), ['/edge/v1/models']);

    const closed = http.createServer();
    await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
    const offlineURL = `http://127.0.0.1:${closed.address().port}/v1`;
    await new Promise(resolve => closed.close(resolve));
    const offlineLoader = await plugin.auth.loader(async () => ({
      ...authFor('native-catalog-offline'), metadata: { baseURL: offlineURL }
    }));
    const failure = await post(offlineLoader, `${offlineURL}/models/${model}:generateContent`);
    assert.equal(failure.status, 502);
    assert.equal(failure.headers.get(UNREACHABLE_HEADER), 'unreachable');
  });

  it('rejects snake_case protocol aliases and preserves custom JSON including wrapped counts', async () => {
    const loader = await plugin.auth.loader(async () => authFor());
    const target = url('generateContent');
    const aliasedBodies = [
      [{ ...text, tools: [{ function_declarations: [{ name: 'read' }] }] }, /functionDeclarations/],
      [{ contents: [{ parts: [{ text: 'ping' }, { inline_data: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] }] }, /inlineData/],
      [{ ...text, tool_config: { functionCallingConfig: { mode: 'NONE' } } }, /toolConfig/],
      [{ ...text, generationConfig: { thinkingConfig: { include_thoughts: true } } }, /includeThoughts/],
      [{ ...text, tools: [{ functionDeclarations: [], function_declarations: [] }] }, /ambiguous/i]
    ];
    const hit = seen.length;
    for (const [body, message] of aliasedBodies) {
      const res = await post(loader, target, body, { headers: { 'x-magpie-effort': 'low' } });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error.message, message);
    }
    assert.equal(seen.length, hit);

    const raw = `{
      "contents": [{"parts":[{"functionCall":{"name":"read","args":{"file_id":9007199254740993,"fileId":"different"}}}]}],
      "tools": [{"functionDeclarations":[{"name":"read","parametersJsonSchema":{"properties":{"file_id":{"const":9007199254740995}}}}]}],
      "custom_field": {"inline_data": [9007199254740997]}
    }`;
    const generated = await post(loader, target, raw);
    assert.equal(generated.status, 200);
    await generated.text();
    assert.equal(seen.at(-1).raw, raw);
    const counted = await post(loader, url('countTokens'), `{"generateContent\\u0052equest": ${raw} }`);
    assert.equal(counted.status, 200);
    await counted.text();
    assert.equal(seen.at(-1).raw, raw);
  });

  it('allows explicit NONE with tools disabled and rejects declarations, history or other modes', async () => {
    const restricted = await GeminiWebPlugin({}, { allowTools: false });
    const loader = await restricted.auth.loader(async () => authFor('native-none'));
    const target = url('generateContent');
    const withMode = mode => ({ ...text, toolConfig: { functionCallingConfig: { mode } } });
    const res = await post(loader, target, { ...withMode('NONE'), tools: [] });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(JSON.parse(seen.at(-1).raw).toolConfig.functionCallingConfig.mode, 'NONE');
    const hit = seen.length;
    for (const body of [
      withMode('AUTO'), withMode('ANY'), withMode('VALIDATED'), withMode(undefined),
      { ...withMode('NONE'), tools: [{ functionDeclarations: [{ name: 'read' }] }] },
      { ...withMode('NONE'), contents: [{ parts: [{ functionCall: { name: 'read', args: {} } }] }] },
      { ...withMode('NONE'), contents: [{ parts: [{ functionResponse: { name: 'read', response: {} } }] }] }
    ]) {
      const blocked = await post(loader, target, body);
      assert.equal(blocked.status, 400);
      assert.match((await blocked.json()).error.message, /Tool calls are turned off/);
    }
    assert.equal(seen.length, hit);
  });

  it('ignores an upstream recovery marker without replaying a managed POST', async () => {
    const previousDir = process.env.GEMINI_WEB_DATA_DIR;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-native-recovery-test-'));
    const key = 'native-recovery-test';
    const localBaseURL = `${origin}/v1`;
    const target = `${localBaseURL}/models/${model}:generateContent`;
    // A responding setup with a binary path takes ensureBackend's early return. No binary runs.
    const bin = binaryPath(dataDir);
    fs.mkdirSync(path.dirname(bin));
    fs.writeFileSync(bin, '');
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: server.address().port }));
    fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify({ apiKey: key, adminToken: 'fixture' }));
    process.env.GEMINI_WEB_DATA_DIR = dataDir;
    try {
      const loader = await plugin.auth.loader(async () => ({ ...authFor(key), metadata: { baseURL: localBaseURL } }));
      for (const status of [429, 403, 401]) {
        const hit = seen.length;
        const body = { contents: [{ parts: [{ text: String(status) }] }] };
        const res = await post(loader, target, body);
        assert.equal(res.status, status);
        assert.equal(res.headers.get('retry-after'), status === 429 ? '37' : null);
        assert.equal(res.headers.get('x-magpie-sign-in'), status === 401 ? 'kept' : null);
        assert.equal(await res.text(), errorJSON);
        const requests = status === 429 ? ['/v1/models', new URL(target).pathname] : [new URL(target).pathname];
        assert.deepEqual(seen.slice(hit).map(r => r.url), requests);
        assert.equal(res.headers.get(UNREACHABLE_HEADER), null);
      }

      const chatURL = `${localBaseURL}/chat/completions`;
      const chatBody = `{ "model":"${model}", "messages":[], "ext":9007199254740993 }\n`;
      const cases = [
        [target, '{ "contents":[{"parts":[{"text":"recover"}]}], "ext":9007199254740993 }\n'],
        [chatURL, chatBody],
        [chatURL, chatBody, true]
      ];
      for (const [retryTarget, raw, inheritedMethod] of cases) {
        const hit = seen.length;
        const upload = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(raw));
            controller.close();
          }
        });
        const fetch = globalThis.fetch;
        const attempts = [];
        // Exercise the plugin's recovery without depending on the runtime's socket-level retries.
        globalThis.fetch = (url, init) => {
          if (url === retryTarget) {
            attempts.push([init.method, init.headers.get('accept'), init.body]);
            if (attempts.length === 1) return Promise.reject(new TypeError('fixture connection refused'));
          }
          return fetch(url, init);
        };
        try {
          const accept = inheritedMethod ? 'application/vnd.retry-fixture+json' : 'application/json';
          const request = inheritedMethod
            ? new Request(retryTarget)
            : new Request(retryTarget, { method: 'POST', body: upload, duplex: 'half' });
          const init = inheritedMethod
            ? Object.assign(Object.create({ method: 'POST', headers: { Accept: accept } }), { body: raw })
            : undefined;
          const recovered = await loader.fetch(request, init);
          assert.equal(recovered.status, 200);
          await recovered.text();
          assert.equal(request.bodyUsed, !inheritedMethod);
          assert.deepEqual(attempts, [['POST', accept, raw], ['POST', accept, raw]]);
          assert.deepEqual(seen.slice(hit).map(r => [r.url, r.raw]), [
            ['/v1/models', ''], [new URL(retryTarget).pathname, raw]
          ]);
        } finally {
          globalThis.fetch = fetch;
        }
      }
    } finally {
      process.env.GEMINI_WEB_DATA_DIR = previousDir;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('cancels an open upload without waiting for its producer', async () => {
    const loader = await plugin.auth.loader(async () => authFor('native-upload-abort'));
    const target = url('generateContent');
    const reason = new Error('cancel open upload');
    const bounded = async (promise, message) => {
      let timer;
      try {
        return await Promise.race([promise, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), 1000);
        })]);
      } finally {
        clearTimeout(timer);
      }
    };
    const hit = seen.length;
    for (const requestInput of [false, true]) {
      const ctl = new AbortController();
      let source, waiting, cancelled;
      const waitingForMore = new Promise(resolve => { waiting = resolve; });
      const producerCancelled = new Promise(resolve => { cancelled = resolve; });
      const body = new ReadableStream({
        pull(controller) {
          if (source) {
            waiting();
          } else {
            source = controller;
            controller.enqueue(new TextEncoder().encode('{"contents":'));
          }
        },
        cancel() {
          cancelled();
          return new Promise(() => {});
        }
      }, { highWaterMark: 0 });
      const init = { method: 'POST', body, duplex: 'half', signal: ctl.signal };
      const pending = requestInput ? loader.fetch(new Request(target, init)) : loader.fetch(target, init);
      try {
        await bounded(waitingForMore, 'request did not start reading the upload');
        ctl.abort(reason);
        await bounded(assert.rejects(pending, error => error === reason), 'request waited for the open upload');
        await bounded(producerCancelled, 'request left the upload producer active');
        assert.equal(body.locked, false);
      } finally {
        source?.error(reason);
        await pending.catch(() => {});
      }
    }
    assert.equal(seen.length, hit, 'abort should reach neither the catalog nor generation');
  });

  it('preserves the abort reason before reading, maps an upload error to 400, and keeps streamed JSON bytes', async () => {
    const loader = await plugin.auth.loader(async () => authFor('native-upload-read'));
    const target = url('generateContent');
    const ctl = new AbortController();
    const reason = new Error('already cancelled');
    ctl.abort(reason);
    const hit = seen.length;
    const unused = new ReadableStream({ pull() { assert.fail('aborted request read its body'); } }, { highWaterMark: 0 });
    await assert.rejects(loader.fetch(target, { method: 'POST', body: unused, duplex: 'half', signal: ctl.signal }),
      error => error === reason);
    const broken = new ReadableStream({ pull(controller) { controller.error(new Error('broken upload')); } });
    const bad = await loader.fetch(target, { method: 'POST', body: broken, duplex: 'half' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.message, 'Failed to read request body');
    assert.equal(seen.length, hit, 'failed reads should reach neither the catalog nor generation');

    const raw = '{ "contents": [{"parts":[{"text":"鹊"}]}], "ext": 9007199254740993 }\n';
    const bytes = new TextEncoder().encode(raw);
    const split = raw.indexOf('鹊') + 1;
    const complete = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, split));
        controller.enqueue(bytes.subarray(split));
        controller.close();
      }
    });
    const ok = await loader.fetch(target, { method: 'POST', body: complete, duplex: 'half' });
    assert.equal(ok.status, 200);
    await ok.text();
    assert.deepEqual(seen.slice(hit).map(r => r.url), ['/edge/v1/models', new URL(target).pathname]);
    assert.equal(seen.at(-1).raw, raw);
  });

  for (const [name, createPlugin] of [
    ['Gemini Web Chat', () => plugin],
    ['AI Studio', () => AIStudioPlugin({}, { studio: { baseURL } })]
  ]) {
    describe(`${name} Request body compatibility`, () => {
      const raw = `{ "model": "${model}", "messages": [{"role": "user", "content": "鹊"}], "ext": 9007199254740993 }\n`;
      const bytes = new TextEncoder().encode(raw);
      let loader, target;
      const request = (chunks, signal) => new Request(target, {
        method: 'POST', duplex: 'half', signal,
        body: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          }
        })
      });

      before(async () => {
        const service = await createPlugin();
        loader = await service.auth.loader(async () => authFor());
        target = `${baseURL}/chat/completions`;
      });

      it('forwards Uint8Array chunks from a separate vm realm and rejects non-byte chunks', async () => {
        const foreignBytes = runInNewContext('new Uint8Array(bytes)', { bytes });
        assert.equal(foreignBytes instanceof Uint8Array, false);
        const hit = seen.length;
        for (const init of [undefined, { headers: { accept: 'application/json' } }]) {
          const ok = await loader.fetch(request([foreignBytes]), init);
          assert.equal(ok.status, 200);
          await ok.text();
        }
        const expected = [new URL(target).pathname, raw];
        assert.deepEqual(seen.slice(hit).map(r => [r.url, r.raw]), [expected, expected]);

        const bad = await loader.fetch(request([raw]));
        assert.equal(bad.status, 400);
        assert.equal((await bad.json()).error.message, 'Failed to read request body');
        assert.equal(seen.length, hit + 2);
      });

      it('rejects inherited consumed and locked bodies, with or without other init fields', async () => {
        const hit = seen.length;
        const partial = request([new TextEncoder().encode('already consumed'), bytes]);
        const reader = partial.body.getReader();
        assert.equal((await reader.read()).done, false);
        reader.releaseLock();
        assert.equal(partial.bodyUsed, true);
        const locked = request([bytes]);
        const lock = locked.body.getReader();
        try {
          for (const input of [partial, locked]) {
            await assert.rejects(loader.fetch(input), { name: 'TypeError' });
            await assert.rejects(loader.fetch(input, { headers: { accept: 'application/json' } }), { name: 'TypeError' });
          }
          assert.equal(seen.length, hit, 'unusable bodies must not reach the backend');
        } finally {
          lock.releaseLock();
        }

        const replaced = await loader.fetch(partial, { body: raw });
        assert.equal(replaced.status, 200);
        await replaced.text();
        assert.deepEqual(seen.slice(hit).map(r => [r.url, r.raw]), [[new URL(target).pathname, raw]]);
      });

      it('propagates the abort reason for a pre-aborted Request with a locked body', async () => {
        const controller = new AbortController();
        const input = request([bytes], controller.signal);
        const reader = input.body.getReader();
        const reason = new Error('cancel locked upload');
        const hit = seen.length;
        try {
          controller.abort(reason);
          await assert.rejects(loader.fetch(input), err => err === reason);
          assert.equal(seen.length, hit);
        } finally {
          reader.releaseLock();
        }
      });
    });
  }
});
