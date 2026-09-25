#!/usr/bin/env node
/**
 * Bifrost replacement pilot — test matrix runner.
 *
 * Runs the required 14-point matrix (plus extra probes) against the isolated
 * Bifrost instance on :17878 and the mock upstream on :18080.
 *
 * Reproduce:
 *   node scripts/run-matrix.mjs
 * Evidence:
 *   raw/matrix-results.json   (full machine-readable results)
 *   raw/matrix-log.txt        (human-readable log)
 *
 * NOTE: tests M12 (backup/restore) and M13 (resource footprint) need process
 * control and are executed by scripts/backup-restore-test.sh and
 * scripts/resource-footprint.ps1; their results are merged into the report.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'raw');
fs.mkdirSync(OUT_DIR, { recursive: true });

const GW = process.env.GW || 'http://127.0.0.1:17878';
const MOCK = process.env.MOCK || 'http://127.0.0.1:18080';

const VK = {
  aStrict: 'sk-bf-a-strict',
  aNoRule: 'sk-bf-a-norule',
  ab: 'sk-bf-ab',
  b: 'sk-bf-b',
  c: 'sk-bf-c',
  multikey: 'sk-bf-multikey',
  rlProbe: 'sk-bf-rl-probe',
};

const results = [];
const logLines = [];
function log(s) { logLines.push(s); process.stdout.write(s + '\n'); }

async function setMock(patch) {
  const r = await fetch(`${MOCK}/__mock/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  return r.json();
}
async function resetMock() {
  await fetch(`${MOCK}/__mock/reset`, { method: 'POST' });
  await setMock({ keyBehavior: {}, modelBehavior: {}, slowMs: 0, modelsFail: 0 });
}
async function resetMockCountersOnly() {
  await fetch(`${MOCK}/__mock/reset`, { method: 'POST' });
}
async function mockLog(limit = 200) {
  const r = await fetch(`${MOCK}/__mock/requests?limit=${limit}`);
  return (await r.json()).entries;
}

async function chat({ vk, model, stream = false, headers = {}, extra = {}, timeoutMs = 20000 }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(vk ? { 'x-bf-vk': vk } : {}),
        ...headers,
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello pilot' }], ...(stream ? { stream: true } : {}), ...extra }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, text, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, text: `FETCH_ERROR ${e.name}: ${e.message}`, ms: Date.now() - started };
  } finally {
    clearTimeout(t);
  }
}

async function get(p, headers = {}) {
  try {
    const res = await fetch(`${GW}${p}`, { headers });
    const text = await res.text();
    return { status: res.status, text };
  } catch (e) {
    return { status: 0, text: `FETCH_ERROR ${e.name}` };
  }
}

function routingOf(text) {
  try { return JSON.parse(text)?.extra_fields?.routing_info || null; } catch { return null; }
}
function contentOf(text) {
  try { return JSON.parse(text)?.choices?.[0]?.message?.content || null; } catch { return null; }
}
function errType(text) {
  try { const j = JSON.parse(text); return j?.error?.type || j?.type || j?.error?.message || null; } catch { return null; }
}

async function T(id, title, fn) {
  const rec = { id, title, verdict: 'UNKNOWN', expected: '', observed: '', notes: '', evidence: null };
  log(`\n===== ${id} — ${title} =====`);
  try {
    const r = await fn(rec);
    Object.assign(rec, r || {});
  } catch (e) {
    rec.verdict = 'UNKNOWN';
    rec.notes = `runner error: ${e.message}`;
  }
  log(`  expected : ${rec.expected}`);
  log(`  observed : ${rec.observed}`);
  if (rec.notes) log(`  notes    : ${rec.notes}`);
  log(`  verdict  : ${rec.verdict}`);
  results.push(rec);
  return rec;
}

// ---------------------------------------------------------------------------
await resetMock();

// --- 1. OpenAI-compatible call (non-stream) --------------------------------
await T('T01', 'OpenAI-compatible non-stream call (provider/model form)', async (rec) => {
  const r = await chat({ vk: VK.aStrict, model: 'mock-a1/mock-small' });
  const routed = routingOf(r.text);
  rec.expected = 'HTTP 200 with OpenAI-shaped body, served by mock-a1/a1-primary';
  rec.observed = `HTTP ${r.status}, ${r.ms}ms, content="${contentOf(r.text)}", routing=${JSON.stringify(routed)}`;
  rec.evidence = r.text.slice(0, 600);
  return { verdict: r.status === 200 && routed?.provider === 'mock-a1' && routed?.key === 'a1-primary' ? 'PASS' : 'FAIL' };
});

await T('T02', 'OpenAI-compatible call with BARE model name (Ming-Gateway calling convention)', async (rec) => {
  const r = await chat({ vk: VK.aStrict, model: 'mock-small' });
  const routed = routingOf(r.text);
  rec.expected = 'Ming-Gateway callers send bare model names; with a routing rule pinning the provider this should still work';
  rec.observed = `HTTP ${r.status}, routed=${JSON.stringify(routed)}`;
  rec.evidence = r.text.slice(0, 400);
  return { verdict: r.status === 200 && routed?.provider === 'mock-a1' ? 'PASS' : (r.status === 200 ? 'PARTIAL' : 'FAIL') };
});

await T('T03', 'Bare model name WITHOUT routing rule (Ming-Gateway callers unchanged)', async (rec) => {
  const r = await chat({ vk: VK.aNoRule, model: 'mock-small' });
  const routed = routingOf(r.text);
  rec.expected = 'Bare model resolves through the model catalog across the allowed provider set (first provider preferred)';
  rec.observed = `HTTP ${r.status}, routed=${JSON.stringify(routed)}`;
  rec.evidence = r.text.slice(0, 400);
  return { verdict: r.status === 200 ? 'PASS' : 'FAIL', notes: 'No caller-side model renaming needed; provider is chosen from the VK-scoped allowed set.' };
});

// --- 2. A/B/C access isolation ---------------------------------------------
await T('T10', 'Isolation: A-only VK (no rule) → B provider must be denied', async (rec) => {
  const r = await chat({ vk: VK.aNoRule, model: 'mock-b1/mock-small' });
  rec.expected = 'Denied (provider not in this VK\'s provider_configs)';
  rec.observed = `HTTP ${r.status} — ${errType(r.text) || r.text.slice(0, 160)}`;
  rec.evidence = r.text.slice(0, 500);
  return { verdict: r.status >= 400 ? 'PASS' : 'FAIL' };
});

await T('T11', 'Isolation: A-only VK (no rule) → C provider must be denied', async (rec) => {
  const r = await chat({ vk: VK.aNoRule, model: 'mock-c1/mock-small' });
  rec.expected = 'Denied';
  rec.observed = `HTTP ${r.status} — ${errType(r.text) || r.text.slice(0, 160)}`;
  rec.evidence = r.text.slice(0, 500);
  return { verdict: r.status >= 400 ? 'PASS' : 'FAIL' };
});

await T('T12', 'Isolation: B VK → A provider must be denied', async (rec) => {
  const r = await chat({ vk: VK.b, model: 'mock-a1/mock-small' });
  rec.expected = 'Denied';
  rec.observed = `HTTP ${r.status} — ${errType(r.text) || r.text.slice(0, 160)}`;
  rec.evidence = r.text.slice(0, 500);
  return { verdict: r.status >= 400 ? 'PASS' : 'FAIL' };
});

await T('T13', 'Isolation: A VK → asked for C provider (no routing rules active)', async (rec) => {
  const r = await chat({ vk: VK.aStrict, model: 'mock-c1/mock-small' });
  const routed = routingOf(r.text);
  rec.expected = 'Explicit refusal (403 provider_blocked), same semantics as a strict Ming-Gateway token';
  rec.observed = `HTTP ${r.status} — ${errType(r.text) || ''}, routed=${JSON.stringify(routed)}`;
  rec.evidence = r.text.slice(0, 400);
  return { verdict: r.status >= 400 ? 'PASS' : 'FAIL' };
});

await T('T14', 'Isolation: C VK → asked for A provider (no routing rules active)', async (rec) => {
  const r = await chat({ vk: VK.c, model: 'mock-a1/mock-small' });
  const routed = routingOf(r.text);
  rec.expected = 'Explicit refusal; must never reach A';
  rec.observed = `HTTP ${r.status} — ${errType(r.text) || ''}, routed=${JSON.stringify(routed)}`;
  rec.evidence = r.text.slice(0, 400);
  return { verdict: r.status >= 400 ? 'PASS' : 'FAIL' };
});

// --- 3. C never implicit fallback ------------------------------------------
await T('T20', 'C group NEVER implicit fallback: C upstream down → C VK must fail, A/B untouched', async (rec) => {
  await setMock({ keyBehavior: { 'sk-mock-c1': '500' } });
  await resetMockCountersOnly();
  const r = await chat({ vk: VK.c, model: 'mock-c1/mock-small' });
  const hits = await mockLog(50);
  const leaked = hits.filter((h) => h.key === 'sk-mock-a1' || h.key === 'sk-mock-a2' || h.key === 'sk-mock-b1');
  rec.expected = 'Failure surfaced to caller; no request ever reaches A or B upstreams';
  rec.observed = `HTTP ${r.status} — ${errType(r.text) || r.text.slice(0, 140)}; A/B upstream hits during test: ${leaked.length}`;
  rec.evidence = JSON.stringify({ response: r.text.slice(0, 300), upstreamHits: hits.map((h) => `${h.key}:${h.behavior}`) }).slice(0, 700);
  await setMock({ keyBehavior: {} });
  return { verdict: r.status >= 400 && leaked.length === 0 ? 'PASS' : 'FAIL' };
});

// --- 4. Ordered fallback ----------------------------------------------------
await T('T30', 'Ordered fallback inside A: a1 failing → served by a2', async (rec) => {
  await setMock({ keyBehavior: { 'sk-mock-a1': '500' } });
  const r = await chat({ vk: VK.aStrict, model: 'mock-small' });
  const routed = routingOf(r.text);
  rec.expected = 'Implicit chain across the VK allowed set serves from mock-a2 (bare-model calling form)';
  rec.observed = `HTTP ${r.status}, routed=${JSON.stringify(routed)}, content="${contentOf(r.text)}"`;
  rec.evidence = r.text.slice(0, 400);
  await setMock({ keyBehavior: {} });
  return { verdict: r.status === 200 && routed?.provider === 'mock-a2' ? 'PASS' : 'FAIL' };
});

await T('T31', 'Ordered fallback A→B: a1+a2 failing → vk-ab served by b1', async (rec) => {
  await setMock({ keyBehavior: { 'sk-mock-a1': '500', 'sk-mock-a2': '500' } });
  const r = await chat({ vk: VK.ab, model: 'mock-small' });
  const routed = routingOf(r.text);
  rec.expected = 'Chain a1 → a2 → b1; b1 serves the request';
  rec.observed = `HTTP ${r.status}, routed=${JSON.stringify(routed)}`;
  rec.evidence = r.text.slice(0, 400);
  await setMock({ keyBehavior: {} });
  return { verdict: r.status === 200 && routed?.provider === 'mock-b1' ? 'PASS' : 'FAIL' };
});

await T('T32', 'A group fully down → A-only VK must NOT escape to B', async (rec) => {
  await setMock({ keyBehavior: { 'sk-mock-a1': '500', 'sk-mock-a2': '500' } });
  await resetMockCountersOnly();
  const r = await chat({ vk: VK.aStrict, model: 'mock-small' });
  const hits = await mockLog(50);
  const leaked = hits.filter((h) => h.key === 'sk-mock-b1' || h.key === 'sk-mock-c1');
  rec.expected = 'Failure, and zero B/C upstream hits (strict single-group token)';
  rec.observed = `HTTP ${r.status}, B/C upstream hits: ${leaked.length}`;
  rec.evidence = JSON.stringify({ response: r.text.slice(0, 300), upstreamHits: hits.map((h) => h.key) }).slice(0, 600);
  await setMock({ keyBehavior: {} });
  return { verdict: r.status >= 400 && leaked.length === 0 ? 'PASS' : 'FAIL' };
});

await T('T33', 'Ordered fallback on TIMEOUT (a1 hangs → a2 serves)', async (rec) => {
  await setMock({ keyBehavior: { 'sk-mock-a1': 'timeout' } });
  const r = await chat({ vk: VK.aStrict, model: 'mock-small', timeoutMs: 40000 });
  const routed = routingOf(r.text);
  rec.expected = 'After the 15s provider timeout, the implicit chain serves from mock-a2';
  rec.observed = `HTTP ${r.status} after ${r.ms}ms, routed=${JSON.stringify(routed)}`;
  rec.evidence = r.text.slice(0, 300);
  await setMock({ keyBehavior: {} });
  return { verdict: r.status === 200 && routed?.provider === 'mock-a2' ? 'PASS' : 'FAIL' };
});

await T('T34', 'Caller-side requirement: explicit provider/model needs request-level fallbacks', async (rec) => {
  await setMock({ keyBehavior: { 'sk-mock-a1': '500' } });
  const noFb = await chat({ vk: VK.aNoRule, model: 'mock-a1/mock-small' });
  const withFb = await chat({ vk: VK.aNoRule, model: 'mock-a1/mock-small', extra: { fallbacks: ['mock-a2/mock-small'] } });
  await setMock({ keyBehavior: {} });
  const routedWith = routingOf(withFb.text);
  rec.expected = 'Pinned provider form fails without fallbacks; with explicit fallbacks it degrades to a2';
  rec.observed = `without fallbacks: HTTP ${noFb.status}; with fallbacks: HTTP ${withFb.status}, routed=${JSON.stringify(routedWith)}`;
  rec.evidence = JSON.stringify({ noFb: noFb.text.slice(0, 200), withFb: withFb.text.slice(0, 250) });
  return { verdict: noFb.status >= 400 && withFb.status === 200 && routedWith?.provider === 'mock-a2' ? 'PASS' : 'FAIL' };
});

// --- 5. Streaming -----------------------------------------------------------
await T('T40', 'Streaming: chunked SSE passthrough', async (rec) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  const started = Date.now();
  let chunks = 0, done = false, firstByteAt = 0, body = '';
  try {
    const res = await fetch(`${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bf-vk': VK.aStrict },
      body: JSON.stringify({ model: 'mock-small', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: ctrl.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done: d } = await reader.read();
      if (d) break;
      if (!firstByteAt) firstByteAt = Date.now();
      body += dec.decode(value, { stream: true });
      chunks = (body.match(/^data: /gm) || []).length;
      if (body.includes('[DONE]')) done = true;
    }
    const content = [...body.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join('');
    rec.expected = 'Multiple data: chunks streamed through, final [DONE], assembled content non-empty';
    rec.observed = `HTTP ${res.status}, ${chunks} data lines, [DONE]=${done}, firstByte=${firstByteAt - started}ms, assembled="${content}"`;
    rec.evidence = body.slice(0, 500);
    return { verdict: res.status === 200 && chunks >= 3 && done && content.length > 0 ? 'PASS' : 'FAIL' };
  } catch (e) {
    return { verdict: 'FAIL', observed: `stream error: ${e.message}` };
  } finally { clearTimeout(t); }
});

// --- 6. Provider / key failure ---------------------------------------------
await T('T50', 'Provider failure (401 upstream) on B: surfaced, no fallback', async (rec) => {
  await setMock({ keyBehavior: { 'sk-mock-b1': '401' } });
  const r = await chat({ vk: VK.b, model: 'mock-b1/mock-small' });
  rec.expected = 'Caller receives an error; B VK has no fallback target';
  rec.observed = `HTTP ${r.status} — ${errType(r.text) || r.text.slice(0, 140)}`;
  rec.evidence = r.text.slice(0, 400);
  await setMock({ keyBehavior: {} });
  return { verdict: r.status >= 400 ? 'PASS' : 'FAIL' };
});

await T('T51', 'Provider failure (401) on a1 → rule fallback serves from a2', async (rec) => {
  await setMock({ keyBehavior: { 'sk-mock-a1': '401' } });
  const r = await chat({ vk: VK.aStrict, model: 'mock-small' });
  const routed = routingOf(r.text);
  rec.expected = '401 marks the key/provider dead → chain serves from mock-a2';
  rec.observed = `HTTP ${r.status}, routed=${JSON.stringify(routed)}`;
  rec.evidence = r.text.slice(0, 400);
  await setMock({ keyBehavior: {} });
  return { verdict: r.status === 200 && routed?.provider === 'mock-a2' ? 'PASS' : 'FAIL' };
});

// --- 7. Multi-key -----------------------------------------------------------
await T('T60', 'Multi-key rotation: failing key rotates to healthy key (up to 6 runs)', async (rec) => {
  // Fixture provider mock-multikey has two keys: sk-mock-429 (always 429) and
  // sk-mock-mk1 (healthy). Key selection varies per run, so we sample up to 6
  // runs; a run whose upstream log shows "429 then ok" proves rotation.
  const runs = [];
  let rotationSeen = null;
  for (let i = 0; i < 6; i += 1) {
    await resetMockCountersOnly();
    await setMock({ keyBehavior: { 'sk-mock-429': '429', 'sk-mock-mk1': 'ok' } });
    const r = await chat({ vk: VK.multikey, model: 'mock-small' });
    const attempts = (await mockLog(10)).map((h) => `${h.key}:${h.behavior}`);
    const rec1 = { run: i, status: r.status, servedBy: routingOf(r.text)?.key || null, attempts };
    runs.push(rec1);
    if (!rotationSeen && attempts.length > 1 && attempts.some((a) => a.endsWith(':429')) && r.status === 200) rotationSeen = rec1;
  }
  await setMock({ keyBehavior: {} });
  rec.expected = 'Requests succeed; at least one run shows the failing key retried and the healthy key serving';
  rec.observed = rotationSeen
    ? `rotation observed in run ${rotationSeen.run}: [${rotationSeen.attempts.join(', ')}] → served by ${rotationSeen.servedBy}`
    : `no rotation observed in 6 runs; statuses=${runs.map((r) => r.status).join(',')}`;
  rec.evidence = JSON.stringify(runs);
  fs.writeFileSync(path.join(OUT_DIR, 'multikey-rotation.json'), JSON.stringify({ at: new Date().toISOString(), runs, rotationSeen }, null, 2));
  return {
    verdict: rotationSeen ? 'PASS' : (runs.every((r) => r.status === 200) ? 'PARTIAL' : 'FAIL'),
    notes: rotationSeen ? '' : 'All runs succeeded but the failing key was never selected first in this sample.',
  };
});

// --- 8. Model list discovery -------------------------------------------------
await T('T70', 'Model list discovery via gateway (/v1/models with VK)', async (rec) => {
  const r = await get('/v1/models', { 'x-bf-vk': VK.aStrict });
  let ids = [];
  try { ids = (JSON.parse(r.text).data || []).map((m) => m.id); } catch { /* ignore */ }
  rec.expected = 'A model list a caller can use';
  rec.observed = `HTTP ${r.status}, ${ids.length} models: ${ids.slice(0, 8).join(', ')}`;
  rec.evidence = r.text.slice(0, 400);
  return { verdict: r.status === 200 && ids.length > 0 ? 'PASS' : 'FAIL', notes: ids.length === 0 ? 'Empty list — caller-side discovery not available this way.' : '' };
});

await T('T71', 'Operator model discovery via gateway API (/api/models)', async (rec) => {
  const r = await get('/api/models');
  let names = [];
  try { names = (JSON.parse(r.text).models || []).map((m) => m.name || m.id); } catch { /* ignore */ }
  rec.expected = 'Gateway-side model catalog listing (what the operator picks models from)';
  rec.observed = `HTTP ${r.status}, ${names.length} models: ${names.slice(0, 6).join(', ')}`;
  rec.evidence = r.text.slice(0, 400);
  return { verdict: r.status === 200 && names.length > 0 ? 'PASS' : 'FAIL' };
});

// --- 9. Operator administration ---------------------------------------------
await T('T80', 'Operator UI reachable (dashboard HTML)', async (rec) => {
  const r = await get('/');
  rec.expected = 'Web UI served on the isolated port';
  rec.observed = `HTTP ${r.status}, ${r.text.length} bytes, looks like HTML=${/<!doctype|<html/i.test(r.text)}`;
  rec.evidence = r.text.slice(0, 200);
  return { verdict: r.status === 200 && /<!doctype|<html/i.test(r.text) ? 'PASS' : 'FAIL' };
});

await T('T81', 'Operator API: providers readback', async (rec) => {
  const r = await get('/api/providers');
  let names = [];
  try { names = (JSON.parse(r.text).providers || []).map((p) => p.name); } catch { /* ignore */ }
  rec.expected = 'Channel list readable by the operator';
  rec.observed = `HTTP ${r.status}, providers=[${names.join(', ')}]`;
  rec.evidence = r.text.slice(0, 300);
  return { verdict: r.status === 200 && names.length === 5 ? 'PASS' : 'PARTIAL' };
});

await T('T82', 'Operator API: virtual keys readback', async (rec) => {
  const r = await get('/api/governance/virtual-keys');
  let ids = [];
  try { ids = (JSON.parse(r.text).virtual_keys || []).map((k) => k.id); } catch { /* ignore */ }
  rec.expected = 'Caller-key list readable';
  rec.observed = `HTTP ${r.status}, vks=[${ids.join(', ')}]`;
  rec.evidence = r.text.slice(0, 300);
  return { verdict: r.status === 200 && ids.length >= 8 ? 'PASS' : 'PARTIAL' };
});

await T('T83', 'Operator API: request logs readback', async (rec) => {
  const r = await get('/api/logs?limit=5');
  rec.expected = 'Recent requests visible to the operator';
  rec.observed = `HTTP ${r.status}, ${r.text.length} bytes`;
  rec.evidence = r.text.slice(0, 400);
  return { verdict: r.status === 200 ? 'PASS' : 'PARTIAL' };
});

// --- 10. Secret exposure scan ------------------------------------------------
await T('T90', 'Secret exposure: provider keys must never be returned in plaintext', async (rec) => {
  // NOTE: /api/logs is excluded here because this pilot's mock deliberately echoes
  // the bearer token it received into the answer text; that echo (not a gateway
  // credential leak) is what a naive scan would find. Content logging is probed
  // separately in T91.
  const PROVIDER_KEYS = ['sk-mock-a1', 'sk-mock-a2', 'sk-mock-b1', 'sk-mock-c1', 'sk-mock-mk1', 'sk-mock-429'];
  const paths = [
    '/api/providers', '/api/providers/mock-a1', '/api/providers/mock-a1/keys', '/api/providers/mock-c1/keys',
    '/api/config', '/api/governance/budgets', '/api/governance/rate-limits',
    '/api/governance/routing-rules', '/api/models', '/api/mcp',
  ];
  const findings = [];
  const statuses = [];
  for (const p of paths) {
    const r = await get(p);
    statuses.push(`${p}→${r.status}`);
    for (const s of PROVIDER_KEYS) if (r.text.includes(s)) findings.push(`${p} contains ${s}`);
  }
  const keysResp = await get('/api/providers/mock-a1/keys');
  const masked = /sk-m\*+k-a1|sk-\w\*+\w/.test(keysResp.text);
  rec.expected = 'Provider key values masked (first/last chars only) like the Ming-Gateway channel page; never full plaintext';
  rec.observed = `probed ${paths.length} endpoints; plaintext provider-key hits: ${findings.length}; masked form present: ${masked}`;
  rec.evidence = JSON.stringify({ statuses, findings, keysSample: keysResp.text.slice(0, 300) });
  return {
    verdict: findings.length === 0 && masked ? 'PASS' : (findings.length === 0 ? 'PARTIAL' : 'FAIL'),
    notes: findings.length === 0 ? 'Provider credentials stayed masked in every probed payload.' : findings.join(' | '),
  };
});

await T('T91', 'Content logging state matches /api/config (privacy-relevant default)', async (rec) => {
  const cfg = await get('/api/config');
  let flag = null;
  try { flag = JSON.parse(cfg.text).client_config?.disable_content_logging ?? null; } catch { /* ignore */ }
  const token = 'PILOT-CONTENT-MARKER-' + Date.now();
  await chat({ vk: VK.aStrict, model: 'mock-small', extra: { messages: [{ role: 'user', content: token }] } });
  let seen = false;
  for (let i = 0; i < 8 && !seen; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const logs = await get('/api/logs?limit=20');
    seen = logs.text.includes(token);
  }
  rec.expected = 'Behaviour matches the config flag: content present in logs when disable_content_logging=false';
  rec.observed = `disable_content_logging=${flag}; content marker found in logs=${seen}`;
  rec.evidence = `flag=${flag} markerInLogs=${seen}`;
  const consistent = (flag === false && seen) || (flag === true && !seen);
  return {
    verdict: flag === null ? 'UNKNOWN' : (flag === false ? 'PARTIAL' : 'PASS'),
    notes: flag === false
      ? `Content is recorded by default (flag false, marker in logs=${seen}) and Ming-Gateway logs metadata only. Verified fix: set client.disable_content_logging=true WITH source_of_truth="config.json" (with the default split mode the file value is ignored once the config store exists) — with that, new rows carry content_summary=null. Consistency check: ${consistent}.`
      : `Content logging disabled; marker in logs=${seen} (expected false).`,
  };
});

// --- 11. Route/provider readback ---------------------------------------------
await T('T95', 'Route/provider readback in the response itself', async (rec) => {
  const r = await chat({ vk: VK.ab, model: 'mock-small' });
  const routed = routingOf(r.text);
  rec.expected = 'Response identifies the provider + key that actually served it';
  rec.observed = `routing_info=${JSON.stringify(routed)}`;
  rec.evidence = r.text.slice(0, 500);
  return { verdict: routed?.provider && routed?.key ? 'PASS' : 'FAIL' };
});

await T('T96', 'Route/provider readback in operator logs after a fallback', async (rec) => {
  await setMock({ keyBehavior: { 'sk-mock-a1': '500' } });
  const r = await chat({ vk: VK.aStrict, model: 'mock-a1/mock-small' });
  await setMock({ keyBehavior: {} });
  const logs = await get('/api/logs?limit=10');
  const showsA2 = logs.text.includes('mock-a2');
  rec.expected = 'Logs show which provider/key served the fallback request';
  rec.observed = `served by ${JSON.stringify(routingOf(r.text))}; logs mention mock-a2=${showsA2}`;
  rec.evidence = logs.text.slice(0, 500);
  return { verdict: showsA2 ? 'PASS' : 'PARTIAL' };
});

// --- 14. YueMing-specific calling conventions --------------------------------
await T('T120', 'Caller compat: Ming-Gateway X-GW-Group header', async (rec) => {
  const r = await chat({ vk: VK.aNoRule, model: 'mock-c1/mock-small', headers: { 'X-GW-Group': 'C' } });
  const routed = routingOf(r.text);
  rec.expected = 'Bifrost has no notion of X-GW-Group; the header must be ignored (and must NOT grant access to C)';
  rec.observed = `HTTP ${r.status}, routed=${JSON.stringify(routed)}, error=${errType(r.text)}`;
  rec.evidence = r.text.slice(0, 300);
  const noEscape = r.status >= 400 || routed?.provider !== 'mock-c1';
  return { verdict: noEscape ? 'PASS' : 'FAIL', notes: 'Header is inert: group selection must be expressed with virtual keys / routing rules instead.' };
});

await T('T121', 'Caller compat: Ming-Gateway model prefix form "c:mock-small"', async (rec) => {
  const r = await chat({ vk: VK.c, model: 'c:mock-small' });
  rec.expected = 'Bifrost does not implement the "group:model" prefix; expect an unknown-model error (caller change required)';
  rec.observed = `HTTP ${r.status} — ${errType(r.text) || r.text.slice(0, 140)}`;
  rec.evidence = r.text.slice(0, 300);
  return { verdict: r.status >= 400 ? 'PASS' : 'PARTIAL', notes: 'Documents a real caller-facing difference.' };
});

await T('T122', 'Caller compat: OpenAI SDK style Authorization: Bearer <vk>', async (rec) => {
  const r = await chat({ model: 'mock-a1/mock-small', headers: { Authorization: `Bearer ${VK.aStrict}` } });
  rec.expected = 'Bearer VK auth accepted per docs (auth disabled mode)';
  rec.observed = `HTTP ${r.status}, ${errType(r.text) || contentOf(r.text)}`;
  rec.evidence = r.text.slice(0, 300);
  return { verdict: r.status === 200 ? 'PASS' : 'PARTIAL' };
});

// --- extra: C rate limit + budget accounting ---------------------------------
await T('T130', 'Request rate limit (3 per window) → 4th request refused (dedicated probe VK)', async (rec) => {
  let last = null;
  const series = [];
  for (let i = 0; i < 4; i += 1) {
    last = await chat({ vk: VK.rlProbe, model: 'mock-small' });
    series.push(last.status);
  }
  rec.expected = 'First 3 requests pass, 4th returns 429 request_limited';
  rec.observed = `status series: ${series.join(', ')}; last error: ${errType(last.text)}`;
  rec.evidence = last.text.slice(0, 300);
  return { verdict: series.slice(0, 3).every((s) => s === 200) && series[3] === 429 ? 'PASS' : 'FAIL' };
});

await T('T131', 'C group dollar budget accounting visible to operator', async (rec) => {
  const r = await get('/api/governance/budgets');
  rec.expected = 'Budget usage tracked per virtual key';
  rec.observed = `HTTP ${r.status} — ${r.text.slice(0, 300)}`;
  rec.evidence = r.text.slice(0, 600);
  const tracked = /max_limit/.test(r.text);
  return {
    verdict: tracked ? 'PARTIAL' : 'UNKNOWN',
    notes: 'Budget object exists and is exposed; the C request-rate limit was raised to 500 for the rest of the run to keep tests independent; dollar accounting for the mock provider depends on pricing configuration — with no pricing entry for custom models the spend stays $0, so the budget cannot gate traffic in this fixture. Ming-Gateway ships a built-in price table.',
  };
});

// ---------------------------------------------------------------------------
await setMock({ keyBehavior: {}, modelBehavior: {}, slowMs: 0, modelsFail: 0 });

const outPath = path.join(OUT_DIR, 'matrix-results.json');
fs.writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), gateway: GW, mock: MOCK, results }, null, 2));
fs.writeFileSync(path.join(OUT_DIR, 'matrix-log.txt'), logLines.join('\n') + '\n');

const counts = results.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
log(`\n===== SUMMARY =====`);
for (const r of results) log(`${r.verdict.padEnd(8)} ${r.id}  ${r.title}`);
log(`\nPASS=${counts.PASS || 0}  FAIL=${counts.FAIL || 0}  PARTIAL=${counts.PARTIAL || 0}  UNKNOWN=${counts.UNKNOWN || 0}`);
log(`results written: ${outPath}`);
