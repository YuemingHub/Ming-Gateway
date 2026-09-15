'use strict';

/**
 * 部署前体检：组隔离 / 组内轮换 / 延迟 / 稳定性
 * 运行：node test/deploy-check.js
 *
 * 这个脚本只回答部署前最该确认的四件事：
 *   1. 用某个组的 key，是不是真的只用那个组（不会偷偷串到别的组）
 *   2. 某个渠道「模型不通 / 超时 / 限流」时，是不是真的在组内换下一个渠道
 *   3. 延迟到底多少（p50/p95/p99 + 流式首字节）
 *   4. 持续压力下会不会崩、内存会不会失控
 *
 * 全部依赖 Node 内置模块，无需安装任何东西。
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

const { startMock } = require('./mock-upstream');
const { normalize } = require('../lib/config');
const { GatewayServer } = require('../lib/server');

const GW_PORT = Number(process.env.DEPLOY_GW_PORT || 8299);
const M_BASE = Number(process.env.DEPLOY_MOCK_BASE || 9951);
const P = {
  aHang: M_BASE,      // A 组：挂起不返回（测超时轮换）
  aNoModel: M_BASE + 1, // A 组：404「没有这个模型」（测模型不通轮换）
  aOk: M_BASE + 2,    // A 组主力
  aOk2: M_BASE + 3,   // A 组备用
  bOk: M_BASE + 4,    // B 组
  cOk: M_BASE + 5,    // C 组
};

const DATA_DIR = path.join(__dirname, '.dcheck');
const TOK = { A: 'key-a', B: 'key-b', C: 'key-c', AB: 'key-ab' };

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function request(port, pathname, opts) {
  const o = Object.assign({ method: 'POST', headers: {}, body: null, timeout: 30000 }, opts || {});
  return new Promise((resolve, reject) => {
    // t0 必须在发请求之前取，否则量到的只是「收响应体」的时间，端到端延迟会假到 0ms
    const t0 = Date.now();
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: o.method, headers: o.headers, timeout: o.timeout },
      (res) => {
        const chunks = [];
        let firstByteAt = null;
        res.on('data', (c) => {
          if (firstByteAt === null) firstByteAt = Date.now();
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            ttfbMs: firstByteAt ? firstByteAt - t0 : Date.now() - t0,
            ms: Date.now() - t0,
          })
        );
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (o.body) req.write(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    req.end();
  });
}

let seq = 0;
/** 内容每次都不同，绕开缓存，保证真的打到上游 */
function chat(token, model, extra) {
  seq++;
  return request(GW_PORT, '/v1/chat/completions', {
    headers: Object.assign(
      { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      (extra && extra.headers) || {}
    ),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: `deploy-check-${seq}-${Date.now()}-${Math.random().toString(36).slice(2)}` }],
      stream: !!(extra && extra.stream),
    }),
  });
}

async function jpost(pathname, body) {
  return request(GW_PORT, pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body || {} });
}

async function setEnabled(id, enabled) {
  return jpost('/__gw/api/channel/toggle', { id, enabled });
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

async function main() {
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

  let crashCount = 0;
  process.on('unhandledRejection', () => crashCount++);
  process.on('uncaughtException', () => crashCount++);

  console.log('\n启动 mock 上游...');
  const mocks = [];
  mocks.push(await startMock(P.aHang, { channelId: 'a-hang', mode: 'ok', hangMs: 60000 }));
  mocks.push(await startMock(P.aNoModel, { channelId: 'a-nomodel', mode: 'ok', chatStatus: 404 }));
  mocks.push(await startMock(P.aOk, { channelId: 'a-ok', mode: 'ok' }));
  mocks.push(await startMock(P.aOk2, { channelId: 'a-ok2', mode: 'ok' }));
  mocks.push(await startMock(P.bOk, { channelId: 'b-ok', mode: 'ok' }));
  mocks.push(await startMock(P.cOk, { channelId: 'c-ok', mode: 'ok' }));
  console.log('  mock 已就绪：' + Object.entries(P).map(([k, v]) => `${k}=${v}`).join(' '));

  const doc = {
    server: {
      host: '127.0.0.1',
      port: GW_PORT,
      dataDir: './test/.dcheck',
      maxRetries: 2,
      requestTimeoutMs: 8000,
      connectTimeoutMs: 3000,
      logLevel: 'error',
      adminToken: '',
    },
    groups: {
      A: { name: '稳定开发组', desc: 't', fallbackTo: ['B'], requireExplicit: false, cache: { enabled: false } },
      B: { name: '免费消耗组', desc: 't', fallbackTo: [], requireExplicit: false, cache: { enabled: false } },
      C: { name: '高配置组', desc: 't', fallbackTo: [], requireExplicit: true, cache: { enabled: false } },
    },
    channels: [
      { id: 'a-hang', name: 'A-挂起', group: 'A', provider: 'openai', baseUrl: `http://127.0.0.1:${P.aHang}/v1`, apiKey: 'k', models: ['deepseek-chat'], weight: 100, priority: 1, timeoutMs: 1000, cooldown: { baseSec: 60, maxSec: 900, failThreshold: 99 } },
      { id: 'a-nomodel', name: 'A-没有这个模型', group: 'A', provider: 'openai', baseUrl: `http://127.0.0.1:${P.aNoModel}/v1`, apiKey: 'k', models: ['deepseek-chat'], weight: 100, priority: 2, cooldown: { baseSec: 60, maxSec: 900, failThreshold: 99 } },
      { id: 'a-ok', name: 'A-主力', group: 'A', provider: 'openai', baseUrl: `http://127.0.0.1:${P.aOk}/v1`, apiKey: 'k', models: ['deepseek-chat'], weight: 100, priority: 5 },
      { id: 'a-ok2', name: 'A-备用', group: 'A', provider: 'openai', baseUrl: `http://127.0.0.1:${P.aOk2}/v1`, apiKey: 'k', models: ['deepseek-chat'], weight: 50, priority: 10 },
      { id: 'b-ok', name: 'B-免费', group: 'B', provider: 'openai', baseUrl: `http://127.0.0.1:${P.bOk}/v1`, apiKey: 'k', models: ['deepseek-chat'], weight: 100, priority: 1 },
      { id: 'c-ok', name: 'C-高配', group: 'C', provider: 'openai', baseUrl: `http://127.0.0.1:${P.cOk}/v1`, apiKey: 'k', models: ['deepseek-chat'], weight: 100, priority: 1 },
    ],
    routes: {},
    tokens: [
      { key: TOK.A, name: 'A组key', allowGroups: ['A'] },
      { key: TOK.B, name: 'B组key', allowGroups: ['B'] },
      { key: TOK.C, name: 'C组key', allowGroups: ['C'] },
      { key: TOK.AB, name: 'AB组key', allowGroups: ['A', 'B'] },
    ],
    fallback: { enabled: true, chain: ['A', 'B'], crossGroup: false },
    cache: { enabled: false },
  };

  const config = normalize(doc, path.join(__dirname, '..'));
  const gw = new GatewayServer(config);
  await gw.start();
  console.log(`\n网关已启动：http://127.0.0.1:${GW_PORT}\n`);

  // 干净起步：先把两个故意坏的渠道关掉，组隔离测试跑得快一些
  await setEnabled('a-hang', false);
  await setEnabled('a-nomodel', false);

  // ================================================================ 1. 组隔离
  console.log('[1] 组隔离：用哪个组的 key，就只用哪个组');

  let hits = [];
  for (let i = 0; i < 5; i++) {
    const r = await chat(TOK.A, 'deepseek-chat');
    hits.push(r.headers['x-gw-channel']);
  }
  ok('A 组 key 只落在 A 组渠道', hits.every((h) => h === 'a-ok' || h === 'a-ok2'), hits.join(','));

  hits = [];
  for (let i = 0; i < 3; i++) {
    const r = await chat(TOK.B, 'deepseek-chat');
    hits.push(r.headers['x-gw-channel']);
  }
  ok('B 组 key 只落在 B 组渠道', hits.every((h) => h === 'b-ok'), hits.join(','));

  const rc = await chat(TOK.C, 'deepseek-chat');
  ok('C 组 key 能进 C 组（令牌授权即显式指定）', rc.status === 200 && rc.headers['x-gw-channel'] === 'c-ok',
    `${rc.status} ${rc.headers['x-gw-channel']}`);

  const rAB = await chat(TOK.AB, 'deepseek-chat');
  ok('多组 key（A+B）在 crossGroup=false 时只走链上第一个组', /^a-/.test(rAB.headers['x-gw-channel'] || ''),
    String(rAB.headers['x-gw-channel']));

  const rHdr = await chat(TOK.AB, 'deepseek-chat', { headers: { 'x-gw-group': 'B' } });
  ok('显式 X-GW-Group: B 可以指定到 B 组', rHdr.headers['x-gw-channel'] === 'b-ok', String(rHdr.headers['x-gw-channel']));

  const rBad = await chat(TOK.A, 'deepseek-chat', { headers: { 'x-gw-group': 'C' } });
  ok('A 组 key 不能越权指定 C 组', rBad.status === 403, `实际 ${rBad.status}`);

  // 核心：B 组全挂时，B 组 key 必须报错，而不是悄悄落到 A 组
  await setEnabled('b-ok', false);
  const rDown = await chat(TOK.B, 'deepseek-chat');
  ok('B 组全挂时 B 组 key 直接报错（不串到 A 组）', rDown.status === 503, `实际 ${rDown.status}`);
  let downBody = {};
  try { downBody = JSON.parse(rDown.text); } catch (_) {}
  ok('报错类型是 no_available_channel', /no_available_channel/.test(JSON.stringify(downBody)), rDown.text.slice(0, 120));
  await setEnabled('b-ok', true);

  // ================================================================ 2. 组内轮换
  console.log('\n[2] 组内轮换：某个渠道不通就换下一个（不跨组）');
  await setEnabled('a-hang', true);
  await setEnabled('a-nomodel', true);

  const rRot = await chat(TOK.A, 'deepseek-chat');
  ok('首选渠道超时 + 次选渠道 404，仍能轮换成功', rRot.status === 200, `status=${rRot.status} ${rRot.text.slice(0, 120)}`);
  ok('最终落在能用的 A 组渠道上（没有卡在坏渠道）',
    rRot.headers['x-gw-channel'] === 'a-ok' || rRot.headers['x-gw-channel'] === 'a-ok2',
    String(rRot.headers['x-gw-channel']));
  ok('轮换出来的内容确实来自该渠道', /MOCK:a-ok/.test(rRot.text), rRot.text.slice(0, 120));

  // 主力也停掉 → 应继续退到备用，而不是跨组
  await setEnabled('a-ok', false);
  const rRot2 = await chat(TOK.A, 'deepseek-chat');
  ok('主力停掉后退到 A 组备用渠道', rRot2.status === 200 && rRot2.headers['x-gw-channel'] === 'a-ok2',
    `${rRot2.status} ${rRot2.headers['x-gw-channel']}`);

  // A 组全挂（把两个坏渠道也一起停掉）→ 必须报错，绝不落到 B
  await setEnabled('a-ok2', false);
  await setEnabled('a-hang', false);
  await setEnabled('a-nomodel', false);
  const rAllDown = await chat(TOK.A, 'deepseek-chat');
  ok('A 组全挂时 A 组 key 直接报错（绝不落到 B 组）', rAllDown.status === 503, `实际 ${rAllDown.status}`);
  let allDownBody = {};
  try { allDownBody = JSON.parse(rAllDown.text); } catch (_) {}
  ok('报错类型是 no_available_channel（不是 B 组的结果）',
    /no_available_channel/.test(JSON.stringify(allDownBody)), rAllDown.text.slice(0, 120));

  // 恢复：只留两个好渠道跑延迟与压力测试
  await setEnabled('a-ok', true);
  await setEnabled('a-ok2', true);

  // ================================================================ 3. 延迟
  console.log('\n[3] 延迟');
  const N = 40;
  const lat = [];
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: N }, () => chat(TOK.A, 'deepseek-chat')));
  const wall = Date.now() - t0;
  for (const r of results) lat.push(r.ms);
  lat.sort((a, b) => a - b);
  const bad = results.filter((r) => r.status !== 200).length;
  ok(`并发 ${N} 全部成功`, bad === 0, `失败 ${bad} 个`);
  console.log(`    · 墙钟 ${wall}ms，p50=${pct(lat, 50)}ms  p95=${pct(lat, 95)}ms  p99=${pct(lat, 99)}ms  max=${lat[lat.length - 1]}ms`);
  ok('p95 延迟 < 500ms', pct(lat, 95) < 500, `p95=${pct(lat, 95)}ms`);
  ok('p99 延迟 < 1000ms', pct(lat, 99) < 1000, `p99=${pct(lat, 99)}ms`);

  const rs = await chat(TOK.A, 'deepseek-chat', { stream: true });
  ok('流式请求返回 200 且是 SSE', rs.status === 200 && /text\/event-stream/.test(rs.headers['content-type'] || ''),
    `${rs.status} ${rs.headers['content-type']}`);
  ok('流式首字节 < 1000ms（没有缓冲整段）', rs.ttfbMs < 1000, `${rs.ttfbMs}ms`);
  ok('流式内容完整（含 [DONE]）', /\[DONE\]/.test(rs.text), rs.text.slice(-80));
  console.log(`    · 流式首字节 ${rs.ttfbMs}ms`);

  // ================================================================ 4. 稳定性
  console.log('\n[4] 稳定性：持续压力');
  if (global.gc) global.gc();
  const memBefore = process.memoryUsage().heapUsed;
  const TOTAL = 300;
  const CONC = 20;
  let failuresCount = 0;
  let statuses = {};
  const tS = Date.now();
  for (let i = 0; i < TOTAL / CONC; i++) {
    const batch = await Promise.all(Array.from({ length: CONC }, () => chat(TOK.A, 'deepseek-chat')));
    for (const r of batch) {
      statuses[r.status] = (statuses[r.status] || 0) + 1;
      if (r.status !== 200) failuresCount++;
    }
  }
  const durS = Date.now() - tS;
  if (global.gc) global.gc();
  const memAfter = process.memoryUsage().heapUsed;
  const grewMB = (memAfter - memBefore) / 1024 / 1024;
  console.log(`    · ${TOTAL} 请求 / ${(durS / 1000).toFixed(1)}s，状态码分布 ${JSON.stringify(statuses)}`);
  console.log(`    · 堆内存 ${(memBefore / 1048576).toFixed(1)}MB → ${(memAfter / 1048576).toFixed(1)}MB（增长 ${grewMB.toFixed(1)}MB）`);
  ok('持续压力下全部成功', failuresCount === 0, `失败 ${failuresCount} 个 ${JSON.stringify(statuses)}`);
  ok('没有未捕获异常 / 未处理拒绝', crashCount === 0, `计数 ${crashCount}`);
  ok('内存增长可控（< 80MB）', grewMB < 80, `增长 ${grewMB.toFixed(1)}MB`);

  console.log('\n' + '='.repeat(56));
  console.log(`  部署体检：通过 ${pass} / 失败 ${fail}`);
  if (failures.length) {
    console.log('\n  失败明细：');
    failures.forEach((f) => console.log('   - ' + f));
  }
  console.log('='.repeat(56) + '\n');

  gw.stop();
  mocks.forEach((m) => m.close());
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
