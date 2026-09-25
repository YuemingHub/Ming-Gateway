#!/usr/bin/env node
/**
 * Tiny load generator for the pilot (zero deps).
 *   node scripts/loadgen.mjs --url <endpoint> --n 200 --c 10 [--vk <v>] [--model mock-small]
 * Prints a JSON summary: total, ok, errors, p50/p95 ms, wall ms.
 */
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}).map(([k, v]) => [k, v === true ? process.argv[process.argv.indexOf(`--${k}`) + 1] : v]));

const URL_ = args.url || 'http://127.0.0.1:17878/v1/chat/completions';
const N = Number(args.n || 100);
const C = Number(args.c || 5);
const MODEL = args.model || 'mock-small';
const VK = args.vk || '';
const TOKEN = args.token || '';
const EXTRA_HEADERS = args.header ? Object.fromEntries([args.header.split(':')].map(([k, ...r]) => [k.trim(), r.join(':').trim()])) : {};

const lat = [];
let ok = 0, err = 0;
const t0 = Date.now();

async function one() {
  const started = Date.now();
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(VK ? { 'x-bf-vk': VK } : {}),
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...EXTRA_HEADERS,
      },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'load' }] }),
    });
    await res.text();
    if (res.ok) ok += 1; else err += 1;
  } catch { err += 1; }
  lat.push(Date.now() - started);
}

let next = 0;
async function worker() { while (next < N) { next += 1; await one(); } }
await Promise.all(Array.from({ length: C }, () => worker()));

lat.sort((a, b) => a - b);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] || 0;
console.log(JSON.stringify({ url: URL_, n: N, concurrency: C, ok, err, p50: q(0.5), p95: q(0.95), wallMs: Date.now() - t0 }, null, 2));
