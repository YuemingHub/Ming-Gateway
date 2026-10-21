'use strict';

/**
 * Ming-Gateway #4 — error body / thrown-message redaction.
 *
 * Synthetic only. Mock upstream echoes clearly fake credentials; no real key,
 * production log, .env or data/channels.json is read.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

const { normalize } = require('../lib/config');
const { GatewayServer } = require('../lib/server');

const GW_PORT = Number(process.env.GW4_GW_PORT || 8299);
const LEAK_PORT = Number(process.env.GW4_LEAK_PORT || 9841);
const OK_PORT = Number(process.env.GW4_OK_PORT || 9842);
const STREAM_FAIL_PORT = Number(process.env.GW4_STREAM_FAIL_PORT || 9843);
const AUTH_PORT = Number(process.env.GW4_AUTH_PORT || 9844);
const RATE_PORT = Number(process.env.GW4_RATE_PORT || 9845);
const FORBIDDEN_PORT = Number(process.env.GW4_FORBIDDEN_PORT || 9846);
const DATA_DIR = path.join(__dirname, '.data-error-sanitize');

const SECRET_SK = 'sk-test-FS4-0123456789abcdef';
const SECRET_BEARER = 'synthetic-token-FS4-0123456789';
const SECRET_CUSTOM = 'Fs4Custom9Zx7Q2w8E5r1T6y3U0iO4pA';
const SECRETS = [SECRET_SK, SECRET_BEARER, SECRET_CUSTOM];

const leakText = `upstream echoed key=${SECRET_SK} auth=Bearer ${SECRET_BEARER} custom=${SECRET_CUSTOM}`;
const OK_BODY = JSON.stringify({
  id: 'mock-ok',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK-OK' } }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
});
const STREAM_OK_BODY =
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'MOCK-OK-STREAM' } }] })}\n\n` +
  'data: [DONE]\n\n';

let pass = 0;
let fail = 0;
const failures = [];
const capturedStdout = [];
const originalLog = console.log;

console.log = (...args) => {
  capturedStdout.push(args.map((a) => String(a)).join(' '));
  originalLog(...args);
};

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    originalLog(`  PASS ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    originalLog(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function containsSecret(text) {
  const s = String(text || '');
  return SECRETS.some((secret) => s.includes(secret));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

function startServer(port, handler) {
  const server = http.createServer((req, res) => handler(req, res).catch(() => {
    try {
      res.destroy();
    } catch (_) {}
  }));
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function request(port, pathname, opts) {
  const o = Object.assign({ method: 'POST', headers: {}, body: null, timeout: 8000 }, opts || {});
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: o.method, headers: o.headers, timeout: o.timeout, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finish({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => finish({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), error: e.message }));
        res.on('close', () => finish({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), closed: true }));
      }
    );
    req.on('error', (e) => finish({ status: 0, headers: {}, text: '', error: e.message }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (o.body) req.write(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    req.end();
  });
}

function chat(model, extra) {
  return request(GW_PORT, '/v1/chat/completions', Object.assign({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'synthetic-' + Date.now() }] }),
  }, extra || {}));
}

async function adminJson(pathname) {
  const r = await request(GW_PORT, pathname, { method: 'GET' });
  try {
    return JSON.parse(r.text);
  } catch (_) {
    return null;
  }
}

function readUsageJsonl() {
  if (!fs.existsSync(DATA_DIR)) return '';
  return fs.readdirSync(DATA_DIR)
    .filter((f) => /^usage-.*\.jsonl$/.test(f))
    .map((f) => fs.readFileSync(path.join(DATA_DIR, f), 'utf8'))
    .join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const mocks = [];
  mocks.push(await startServer(LEAK_PORT, async (req, res) => {
    await readBody(req);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: leakText, type: 'server_error' } }));
  }));
  mocks.push(await startServer(OK_PORT, async (req, res) => {
    const body = await readBody(req);
    const parsed = JSON.parse(body || '{}');
    if (parsed.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(STREAM_OK_BODY);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(OK_BODY);
  }));
  mocks.push(await startServer(STREAM_FAIL_PORT, async (req, res) => {
    await readBody(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'MOCK-PARTIAL' } }] })}\n\n`);
    setTimeout(() => {
      try {
        res.destroy();
      } catch (_) {}
    }, 30);
  }));
  mocks.push(await startServer(AUTH_PORT, async (req, res) => {
    await readBody(req);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: leakText, type: 'invalid_request_error' } }));
  }));
  mocks.push(await startServer(RATE_PORT, async (req, res) => {
    await readBody(req);
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: leakText, type: 'rate_limit_error' } }));
  }));
  mocks.push(await startServer(FORBIDDEN_PORT, async (req, res) => {
    await readBody(req);
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: leakText, type: 'permission_error' } }));
  }));

  const doc = {
    server: {
      host: '127.0.0.1',
      port: GW_PORT,
      dataDir: './test/.data-error-sanitize',
      maxRetries: 2,
      requestTimeoutMs: 3000,
      logLevel: 'debug',
      adminToken: '',
    },
    groups: {
      A: { name: 'A', desc: 'test', fallbackTo: [], requireExplicit: false, cache: { enabled: false } },
      B: { name: 'B', desc: 'test', fallbackTo: [], requireExplicit: false, cache: { enabled: false } },
    },
    channels: [
      { id: 'leak', name: 'leak', group: 'A', provider: 'openai', baseUrl: `http://127.0.0.1:${LEAK_PORT}/v1`, apiKey: 'synthetic-channel-key', models: ['leak-model', 'retry-model'], weight: 100, priority: 5, cooldown: { baseSec: 60, maxSec: 900, failThreshold: 99 } },
      { id: 'ok', name: 'ok', group: 'A', provider: 'openai', baseUrl: `http://127.0.0.1:${OK_PORT}/v1`, apiKey: 'synthetic-channel-key', models: ['retry-model', 'ok-model'], weight: 100, priority: 10 },
      { id: 'stream-fail', name: 'stream-fail', group: 'B', provider: 'openai', baseUrl: `http://127.0.0.1:${STREAM_FAIL_PORT}/v1`, apiKey: 'synthetic-channel-key', models: ['stream-fail-model'], weight: 100, priority: 10 },
      { id: 'auth', name: 'auth', group: 'B', provider: 'openai', baseUrl: `http://127.0.0.1:${AUTH_PORT}/v1`, apiKey: 'synthetic-channel-key', models: ['auth-model'], weight: 100, priority: 10 },
      { id: 'rate', name: 'rate', group: 'B', provider: 'openai', baseUrl: `http://127.0.0.1:${RATE_PORT}/v1`, apiKey: 'synthetic-channel-key', models: ['rate-model'], weight: 100, priority: 10 },
      { id: 'forbidden', name: 'forbidden', group: 'B', provider: 'openai', baseUrl: `http://127.0.0.1:${FORBIDDEN_PORT}/v1`, apiKey: 'synthetic-channel-key', models: ['forbidden-model'], weight: 100, priority: 10 },
    ],
    routes: {
      'auth-model': ['B'],
      'rate-model': ['B'],
      'forbidden-model': ['B'],
      'stream-fail-model': ['B'],
    },
    tokens: [],
    fallback: { enabled: false, chain: [] },
    cache: { enabled: false },
    pricing: {},
  };

  const config = normalize(doc, path.join(__dirname, '..'));
  const gw = new GatewayServer(config);
  await gw.start();

  let r = await chat('leak-model');
  let j = null;
  try {
    j = JSON.parse(r.text);
  } catch (_) {}
  ok('terminal upstream 500 preserves status', r.status === 500, `got ${r.status}`);
  ok('terminal upstream 500 caller body has no synthetic secret', !containsSecret(r.text));
  ok('terminal upstream 500 uses stable safe category', j && j.error && j.error.type === 'upstream_error', j && j.error && j.error.type);

  r = await chat('retry-model');
  ok('retriable upstream 500 still fails over to healthy channel', r.status === 200 && r.headers['x-gw-channel'] === 'ok', `${r.status} ${r.headers['x-gw-channel']}`);
  ok('failover caller body has no synthetic secret', !containsSecret(r.text));

  r = await chat('auth-model');
  try {
    j = JSON.parse(r.text);
  } catch (_) {
    j = null;
  }
  ok('terminal 401 preserves status', r.status === 401, `got ${r.status}`);
  ok('terminal 401 caller body has no synthetic secret', !containsSecret(r.text));
  ok('terminal 401 uses stable safe category', j && j.error && j.error.type === 'upstream_error', j && j.error && j.error.type);

  r = await chat('rate-model');
  try {
    j = JSON.parse(r.text);
  } catch (_) {
    j = null;
  }
  ok('terminal 429 preserves status', r.status === 429, `got ${r.status}`);
  ok('terminal 429 caller body has no synthetic secret', !containsSecret(r.text));
  ok('terminal 429 uses stable safe category', j && j.error && j.error.type === 'upstream_error', j && j.error && j.error.type);

  r = await chat('forbidden-model');
  try {
    j = JSON.parse(r.text);
  } catch (_) {
    j = null;
  }
  ok('terminal 403 preserves status', r.status === 403, `got ${r.status}`);
  ok('terminal 403 caller body has no synthetic secret', !containsSecret(r.text));
  ok('terminal 403 uses stable safe category', j && j.error && j.error.type === 'upstream_error', j && j.error && j.error.type);

  const originalCost = gw.pricer.cost;
  let threw = false;
  gw.pricer.cost = function costOnce() {
    if (!threw) {
      threw = true;
      throw new Error(`synthetic thrown failure ${leakText}`);
    }
    return originalCost.apply(this, arguments);
  };
  r = await chat('ok-model');
  gw.pricer.cost = originalCost;
  try {
    j = JSON.parse(r.text);
  } catch (_) {
    j = null;
  }
  ok('attempt-level thrown error preserves 502', r.status === 502, `got ${r.status}`);
  ok('attempt-level thrown error caller body has no synthetic secret', !containsSecret(r.text));
  ok('attempt-level thrown error uses stable category', j && j.error && j.error.type === 'all_channels_failed', j && j.error && j.error.type);

  const originalCandidates = gw.router.candidates;
  gw.router.candidates = function candidatesThrows() {
    throw new Error(`synthetic outer thrown failure ${leakText}`);
  };
  r = await chat('ok-model');
  gw.router.candidates = originalCandidates;
  try {
    j = JSON.parse(r.text);
  } catch (_) {
    j = null;
  }
  ok('outer thrown error preserves 500', r.status === 500, `got ${r.status}`);
  ok('outer thrown error caller body has no synthetic secret', !containsSecret(r.text));
  ok('outer thrown error uses stable category', j && j.error && j.error.type === 'internal_error', j && j.error && j.error.type);

  r = await chat('stream-fail-model', { body: JSON.stringify({ model: 'stream-fail-model', stream: true, messages: [{ role: 'user', content: 'synthetic-stream' }] }) });
  ok('stream mid-failure delivers the bytes already received', /MOCK-PARTIAL/.test(r.text), r.text.slice(0, 120));
  ok('stream mid-failure adds no synthetic secret', !containsSecret(r.text));
  ok('stream mid-failure adds no gateway error body', !/all_channels_failed|internal_error/.test(r.text));

  r = await chat('ok-model');
  ok('normal non-stream success is unchanged', r.status === 200 && /MOCK-OK/.test(r.text), `${r.status} ${r.text.slice(0, 80)}`);
  ok('normal non-stream success payload is byte-identical', r.text === OK_BODY, r.text.slice(0, 120));
  ok('normal non-stream success has no synthetic secret', !containsSecret(r.text));

  r = await chat('ok-model', { body: JSON.stringify({ model: 'ok-model', stream: true, messages: [{ role: 'user', content: 'synthetic-stream-ok' }] }) });
  ok('normal stream success is unchanged', r.status === 200 && /MOCK-OK-STREAM/.test(r.text) && /\[DONE\]/.test(r.text), `${r.status} ${r.text.slice(0, 120)}`);
  ok('normal stream success payload is byte-identical', r.text === STREAM_OK_BODY, r.text.slice(0, 120));
  ok('normal stream success has no synthetic secret', !containsSecret(r.text));

  const probeFetch = await request(GW_PORT, '/__gw/api/models/fetch', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'leak' }),
  });
  ok('admin model fetch response has no synthetic secret', !containsSecret(probeFetch.text));
  ok('admin model fetch still reports the upstream failure', /"ok":false/.test(probeFetch.text), probeFetch.text.slice(0, 160));

  const probeTest = await request(GW_PORT, '/__gw/api/channel/test', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'leak' }),
  });
  ok('admin channel test response has no synthetic secret', !containsSecret(probeTest.text));
  ok('admin channel test still reports the upstream failure', /"ok":false/.test(probeTest.text), probeTest.text.slice(0, 160));

  gw.usage.flush();
  await sleep(300);

  const jsonl = readUsageJsonl();
  const logs = await adminJson('/__gw/api/logs?limit=500');
  const status = await adminJson('/__gw/api/status');
  const channels = await adminJson('/__gw/api/channels');
  const stdout = capturedStdout.join('\n');

  ok('usage JSONL contains no synthetic secret', !containsSecret(jsonl));
  ok('stdout/journal capture contains no synthetic secret', !containsSecret(stdout));
  ok('admin logs response contains no synthetic secret', !containsSecret(JSON.stringify(logs)));
  ok('admin status lastError contains no synthetic secret', !containsSecret(JSON.stringify(status)));
  ok('admin channels lastError contains no synthetic secret', !containsSecret(JSON.stringify(channels)));
  ok('usage JSONL records the upstream status', /"status":500/.test(jsonl), 'missing status 500 record');
  ok('usage JSONL records a safe upstream category', /上游返回 HTTP 500/.test(jsonl), 'missing stable upstream summary');

  const records = jsonl
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
  const upstream500 = records.find((rec) => rec.status === 500 && rec.channelId === 'leak' && rec.error);
  ok(
    'usage JSONL stores only the stable summary for an upstream HTTP error',
    upstream500 && upstream500.error === '上游返回 HTTP 500',
    upstream500 && upstream500.error
  );

  gw.stop();
  for (const m of mocks) {
    await new Promise((resolve) => m.close(resolve));
  }

  console.log = originalLog;
  originalLog('\n========================================================');
  originalLog(`  通过 ${pass} / 失败 ${fail}`);
  if (failures.length) originalLog('  失败项：\n   - ' + failures.join('\n   - '));
  originalLog('========================================================');
  if (fail) process.exitCode = 1;
}

main().catch((error) => {
  console.log = originalLog;
  originalLog('GW4 HARNESS ERROR');
  originalLog(error.stack || error.message);
  process.exitCode = 1;
});
