#!/usr/bin/env node
/**
 * Operator workflow probe (mirrors the Ming-Gateway operator routine):
 *   discover models -> add provider -> add key -> create caller key ->
 *   serve traffic through it -> delete caller key -> delete provider.
 *
 * Nuance found during the pilot: POST /api/providers ignores inline `keys`;
 * keys must be added via POST /api/providers/{name}/keys.
 *
 * Evidence: raw/operator-workflow.json
 */
import fs from 'node:fs';
const GW = 'http://127.0.0.1:17878';
async function j(m, p, b) {
  const r = await fetch(GW + p, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let d = null;
  try { d = JSON.parse(t); } catch { /* html */ }
  return { status: r.status, t, d };
}
const out = { at: new Date().toISOString() };

const models = await j('GET', '/api/models');
out.models = { status: models.status, count: (models.d?.models || []).length, sample: (models.d?.models || []).slice(0, 4).map((m) => m.name) };
console.log('1) model discovery:', out.models.status, out.models.count, 'models');

const prov = await j('POST', '/api/providers', {
  provider: 'mock-temp-op', network_config: { base_url: 'http://127.0.0.1:18080', allow_private_network: true, default_request_timeout_in_seconds: 15, max_retries: 0 },
  custom_provider_config: { base_provider_type: 'openai', allowed_requests: { chat_completion: true, chat_completion_stream: true, list_models: true } },
});
out.createProvider = prov.status;
console.log('2) create provider:', prov.status);

const key = await j('POST', '/api/providers/mock-temp-op/keys', { name: 'op-key', value: 'sk-mock-a2', models: ['*'], weight: 1 });
const keysBack = await j('GET', '/api/providers/mock-temp-op/keys');
out.addKey = { status: key.status, keysTotal: keysBack.d?.total, masked: keysBack.t.match(/sk-m\*+k-a2/)?.[0] || null };
console.log('3) add key:', key.status, '| readback total:', keysBack.d?.total, '| masked:', out.addKey.masked);

const vk = await j('POST', '/api/governance/virtual-keys', { name: 'op vk', provider_configs: [{ provider: 'mock-temp-op', allowed_models: ['*'], key_ids: ['*'] }] });
const vkId = vk.d?.virtual_key?.id;
const vkValue = (await j('GET', '/api/governance/virtual-keys/' + vkId)).d?.virtual_key?.value;
out.createVk = { status: vk.status, id: vkId, valueReadback: !!vkValue };
console.log('4) create caller key:', vk.status, '| value readable (plaintext, by design):', !!vkValue);

const call = await fetch(GW + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bf-vk': vkValue }, body: JSON.stringify({ model: 'mock-small', messages: [{ role: 'user', content: 'op' }] }) });
const callText = await call.text();
let routed = null; try { routed = JSON.parse(callText).extra_fields?.routing_info; } catch { /* ignore */ }
out.callThroughNewProvider = { status: call.status, routed };
console.log('5) call through the new provider:', call.status, JSON.stringify(routed));

out.deleteVk = (await j('DELETE', '/api/governance/virtual-keys/' + vkId)).status;
out.deleteProvider = (await j('DELETE', '/api/providers/mock-temp-op')).status;
const after = await j('GET', '/api/providers');
out.providersAfterCleanup = (after.d?.providers || []).map((p) => p.name);
console.log('6) cleanup:', out.deleteVk, '/', out.deleteProvider, '| providers now:', out.providersAfterCleanup.join(', '));

fs.writeFileSync('raw/operator-workflow.json', JSON.stringify(out, null, 2));
