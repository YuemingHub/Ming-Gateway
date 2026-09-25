#!/usr/bin/env node
/**
 * Mock OpenAI-compatible upstream for the Bifrost replacement pilot.
 *
 * Zero dependencies. Behavior is driven by (a) the bearer token used by the
 * caller (one token per simulated "channel") and (b) an optional JSON state
 * file that the test runner can rewrite between steps.
 *
 * Endpoints:
 *   GET  /v1/models
 *   POST /v1/chat/completions        (JSON, non-stream)
 *   POST /v1/chat/completions        (SSE when body.stream === true)
 *   POST /__mock/config  {json}      set runtime state (also written to state file)
 *   GET  /__mock/config              read current state
 *   POST /__mock/reset               reset counters
 *   GET  /__mock/requests            request log (for route/readback evidence)
 *
 * Per-key behaviors (state.keyBehavior[key] = "ok" | "401" | "429" | "500" | "timeout"):
 *   "ok"      normal answer
 *   "401"     always 401 invalid_api_key
 *   "429"     always 429 rate_limit_exceeded
 *   "500"     always 500 internal error
 *   "timeout" hold the socket open, never answer (for timeout tests)
 *
 * Per-model behaviors (state.modelBehavior[model]) take precedence for 500 only.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.MOCK_PORT || 18080);
const HOST = process.env.MOCK_HOST || '127.0.0.1';
const STATE_FILE = process.env.MOCK_STATE_FILE || path.join(__dirname, 'mock-state.json');
const LOG_FILE = process.env.MOCK_LOG_FILE || path.join(__dirname, 'mock-requests.jsonl');

let state = { keyBehavior: {}, modelBehavior: {}, slowMs: 0 };
let counters = { total: 0, byKey: {}, byModel: {} };

function loadState() {
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch { /* keep current */ }
}

function logRequest(entry) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch { /* best effort */ }
}

const MODELS = [
  { id: 'mock-small', object: 'model', owned_by: 'mock' },
  { id: 'mock-large', object: 'model', owned_by: 'mock' },
  { id: 'mock-fail-model', object: 'model', owned_by: 'mock' },
];

function keyLabel(authHeader) {
  if (!authHeader) return 'none';
  return String(authHeader).replace(/^Bearer\s+/i, '').trim();
}

function chunkText(text) {
  // split into small chunks so streaming is observable
  const out = [];
  for (let i = 0; i < text.length; i += 8) out.push(text.slice(i, i + 8));
  return out;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function num(v, d) { return Number.isFinite(v) ? v : d; }

const server = http.createServer((req, res) => {
  loadState();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = keyLabel(req.headers['authorization'] || req.headers['api-key'] || req.headers['x-api-key']);

  // ---- control plane -------------------------------------------------
  if (url.pathname === '/__mock/config' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try {
        const next = JSON.parse(raw || '{}');
        state = { ...state, ...next };
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        sendJson(res, 200, { ok: true, state });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e) });
      }
    });
    return;
  }
  if (url.pathname === '/__mock/config' && req.method === 'GET') {
    return sendJson(res, 200, { state, counters });
  }
  if (url.pathname === '/__mock/reset' && req.method === 'POST') {
    counters = { total: 0, byKey: {}, byModel: {} };
    try { fs.writeFileSync(LOG_FILE, ''); } catch { /* best effort */ }
    return sendJson(res, 200, { ok: true, counters });
  }
  if (url.pathname === '/__mock/requests' && req.method === 'GET') {
    let lines = [];
    try { lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean); } catch { /* none */ }
    const limit = Number(url.searchParams.get('limit') || 100);
    return sendJson(res, 200, { count: lines.length, entries: lines.slice(-limit).map((l) => JSON.parse(l)) });
  }

  // ---- OpenAI-compatible surface ------------------------------------
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    // /v1/models itself can be forced to fail for the provider, for discovery tests
    if (state.modelsFail) return sendJson(res, state.modelsFail, { error: { message: 'models endpoint unavailable', type: 'mock_error' } });
    return sendJson(res, 200, { object: 'list', data: MODELS });
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: { message: 'bad json', type: 'invalid_request_error' } }); }

      const behavior0 = state.keyBehavior[key] || 'ok';
      // '429once' returns 429 on this key's FIRST call only — used to make the
      // preferred key fail once so key rotation is observable upstream.
      const behavior = behavior0 === '429once'
        ? ((counters.byKey[key] || 0) === 0 ? '429' : 'ok')
        : behavior0;
      const model = body.model || 'unknown';
      counters.total += 1;
      counters.byKey[key] = (counters.byKey[key] || 0) + 1;
      counters.byModel[model] = (counters.byModel[model] || 0) + 1;

      const entry = {
        at: new Date().toISOString(),
        key, model, stream: !!body.stream,
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        behavior,
        n: counters.total,
      };
      logRequest(entry);

      if (behavior === 'timeout') {
        // never answer; let the upstream client time out
        return;
      }
      if (behavior === '401') return sendJson(res, 401, { error: { message: 'invalid api key (mock)', type: 'invalid_request_error' } });
      if (behavior === '429') return sendJson(res, 429, { error: { message: 'rate limit (mock)', type: 'rate_limit_exceeded' } });
      if (behavior === '500') return sendJson(res, 500, { error: { message: 'upstream exploded (mock)', type: 'server_error' } });
      if (state.modelBehavior && state.modelBehavior[model]) {
        return sendJson(res, 500, { error: { message: `model ${model} forced failure (mock)`, type: 'server_error' } });
      }

      const text = `mock-answer key=${key} model=${model} n=${counters.total}`;
      const created = Math.floor(Date.now() / 1000);
      const id = 'chatcmpl-mock-' + crypto.randomUUID().slice(0, 8);

      if (body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const chunks = chunkText(text);
        let i = 0;
        const push = () => {
          loadState();
          if (i === 0) {
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
          }
          if (i < chunks.length) {
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }] })}\n\n`);
            i += 1;
            const delay = num(state.streamDelayMs, 15);
            setTimeout(push, delay);
          } else {
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: chunks.length, total_tokens: 11 + chunks.length } })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
        };
        push();
        return;
      }

      const slow = num(state.slowMs, 0);
      const finish = () => {
        sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 8, total_tokens: 19 },
        });
      };
      if (slow > 0) setTimeout(finish, slow); else finish();
    });
    return;
  }

  sendJson(res, 404, { error: { message: `no mock route for ${req.method} ${url.pathname}`, type: 'invalid_request_error' } });
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-upstream] listening on http://${HOST}:${PORT}  state=${STATE_FILE} log=${LOG_FILE}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
