#!/usr/bin/env node
/**
 * Failover semantics probe: two calling forms x two failure modes.
 *
 *   Form 1 (Ming-Gateway callers): bare model name  -> catalog resolution across
 *           the virtual key's allowed providers.
 *   Form 2 (Bifrost-native):       provider/model    -> pinned provider.
 *
 * Observed outcome determines whether the Ming-Gateway ordered-degrade chain is
 * expressible without any caller change (routing rules disabled in the fixture).
 *
 * Evidence: raw/failover-semantics.json
 */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'raw');
const GW = 'http://127.0.0.1:17878', MOCK = 'http://127.0.0.1:18080';

async function setMock(p) { await fetch(`${MOCK}/__mock/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); }
async function chat({ vk, model, extra = {} }) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 30000);
  try {
    const r = await fetch(`${GW}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bf-vk': vk }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'p' }], ...extra }), signal: c.signal });
    const x = await r.text(); let routed = null, err = null;
    try { const j = JSON.parse(x); routed = j.extra_fields?.routing_info || null; err = j.error?.message || null; } catch {}
    return { status: r.status, routed, err };
  } catch (e) { return { status: 0, routed: null, err: 'ERR ' + e.name }; } finally { clearTimeout(t); }
}
async function hits() { const r = await fetch(`${MOCK}/__mock/requests?limit=30`); return (await r.json()).entries; }

const cases = [
  ['bare model, all healthy (deterministic primary?)', 'sk-bf-a-norule', 'mock-small', {}, {}],
  ['bare model, a1=500 (in-group failover?)', 'sk-bf-a-norule', 'mock-small', { 'sk-mock-a1': '500' }, {}],
  ['bare model, a1+a2=500 (A->B degrade?)', 'sk-bf-ab-norule', 'mock-small', { 'sk-mock-a1': '500', 'sk-mock-a2': '500' }, {}],
  ['bare model, a1=401 (auth failure)', 'sk-bf-a-norule', 'mock-small', { 'sk-mock-a1': '401' }, {}],
  ['explicit provider/model, a1=500 (no request fallbacks)', 'sk-bf-a-norule', 'mock-a1/mock-small', { 'sk-mock-a1': '500' }, {}],
  ['explicit provider/model, a1=500 + request fallbacks', 'sk-bf-a-norule', 'mock-a1/mock-small', { 'sk-mock-a1': '500' }, { fallbacks: ['mock-a2/mock-small'] }],
  ['bare model, C-only VK, c1=500 (C never falls back)', 'sk-bf-c', 'mock-small', { 'sk-mock-c1': '500' }, {}],
];

const evidence = { at: new Date().toISOString(), gateway: 'bifrost v2.2.3', cases: [] };
for (const [name, vk, model, behavior, extra] of cases) {
  await fetch(`${MOCK}/__mock/reset`, { method: 'POST' });
  await setMock({ keyBehavior: behavior });
  const r = await chat({ vk, model, extra });
  const attempts = (await hits()).map((h) => `${h.key}:${h.behavior}`);
  await setMock({ keyBehavior: {} });
  evidence.cases.push({ name, vk, model, extra, status: r.status, routed: r.routed, err: r.err, upstreamAttempts: attempts });
  console.log(`--- ${name}\n    status=${r.status} routed=${JSON.stringify(r.routed)} err=${r.err || ''}\n    attempts: ${attempts.join(', ') || '(none)'}`);
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'failover-semantics.json'), JSON.stringify(evidence, null, 2));
