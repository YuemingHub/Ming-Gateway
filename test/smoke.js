'use strict';

/**
 * 端到端冒烟测试
 * 运行：node test/smoke.js
 *
 * 全部依赖 Node 内置模块，无需安装任何东西。
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

const { startMock } = require('./mock-upstream');
const { normalize, load } = require('../lib/config');
const yaml = require('../lib/yaml');
const { GatewayServer } = require('../lib/server');
const { Auth } = require('../lib/auth');

// 端口可通过环境变量错开，方便在「本地已有一个 demo 实例在跑」时并行执行测试
const GW_PORT = Number(process.env.SMOKE_GW_PORT || 8899);
const MOCK_BASE = Number(process.env.SMOKE_MOCK_BASE || 9901);
const MOCK_PORTS = {
  aFast: MOCK_BASE,
  aSlow: MOCK_BASE + 1,
  aBroken: MOCK_BASE + 2,
  bFree: MOCK_BASE + 3,
  cHigh: MOCK_BASE + 4,
  gemini: MOCK_BASE + 5,   // /models 返回 Gemini 形状
  noModels: MOCK_BASE + 6, // 不提供 /models
  hang: MOCK_BASE + 7,     // 挂着不返回，测探测超时
  headerRequired: MOCK_BASE + 8, // 缺少指定请求头就 400（复刻 OpenCode Go 的会话头要求）
};
/** 一定没人监听的端口，用来测「连不上」的快失败 */
const DEAD_PORT = MOCK_BASE + 30;
const DATA_DIR = path.join(__dirname, '.data');

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
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function request(port, pathname, opts) {
  const o = Object.assign({ method: 'POST', headers: {}, body: null, timeout: 15000 }, opts || {});
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: o.method, headers: o.headers, timeout: o.timeout }, (res) => {
      const chunks = [];
      const t0 = Date.now();
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
        })
      );
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (o.body) req.write(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    req.end();
  });
}

function chat(model, extra) {
  return request(GW_PORT, '/v1/chat/completions', Object.assign({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  }, extra || {}));
}

/**
 * 内容每次都不同的对话请求。
 * 缓存对「temperature 省略」的请求也生效，所以渠道增删改这类
 * 需要真实打上游的断言必须换 body，否则会命中上一次的缓存而看不到路由结果。
 */
function chatFresh(model, tag) {
  return request(GW_PORT, '/v1/chat/completions', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: `gw-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}` }],
    }),
  });
}

async function main() {
  // 干净的环境
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

  console.log('\n启动 mock 上游...');
  const mocks = [];
  mocks.push(await startMock(MOCK_PORTS.aFast, { channelId: 'a-fast', mode: 'ok' }));
  mocks.push(await startMock(MOCK_PORTS.aSlow, { channelId: 'a-slow', mode: 'ok', delayMs: 200 }));
  mocks.push(await startMock(MOCK_PORTS.aBroken, { channelId: 'a-broken', mode: 'fail' }));
  mocks.push(await startMock(MOCK_PORTS.bFree, { channelId: 'b-free', mode: 'ok' }));
  mocks.push(await startMock(MOCK_PORTS.cHigh, { channelId: 'c-high', mode: 'ok', usage: { prompt_tokens: 1000, completion_tokens: 500 } }));
  mocks.push(
    await startMock(MOCK_PORTS.gemini, {
      channelId: 'gemini-shape',
      mode: 'ok',
      modelsShape: 'gemini',
      models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    })
  );
  mocks.push(await startMock(MOCK_PORTS.noModels, { channelId: 'no-models', mode: 'ok', models: null }));
  mocks.push(await startMock(MOCK_PORTS.hang, { channelId: 'hang', mode: 'ok', hangMs: 60000 }));
  mocks.push(
    await startMock(MOCK_PORTS.headerRequired, {
      channelId: 'needs-header',
      mode: 'ok',
      requireHeader: { name: 'x-opencode-session', value: 'gw-test-session' },
    })
  );
  console.log('  mock 已就绪：' + Object.entries(MOCK_PORTS).map(([k, v]) => `${k}=${v}`).join(' '));

  const doc = {
    server: {
      host: '127.0.0.1',
      port: GW_PORT,
      dataDir: './test/.data',
      maxRetries: 2,
      requestTimeoutMs: 8000,
      logLevel: 'error',
      adminToken: '',
    },
    groups: {
      A: { name: '稳定开发组', desc: 'test', fallbackTo: ['B'], requireExplicit: false, cache: { enabled: true, ttlSec: 600 } },
      B: { name: '免费消耗组', desc: 'test', fallbackTo: [], requireExplicit: false, cache: { enabled: false } },
      C: {
        name: '高配置组',
        desc: 'test',
        fallbackTo: [],
        requireExplicit: true,
        budget: { dailyUSD: 0.01, monthlyUSD: 1 }, // 单次 gpt-4o 调用约 $0.0075，两次成功第三次熔断
        cache: { enabled: false },                 // 关闭缓存，保证成本可预测地累加
      },
    },
    channels: [
      { id: 'a-broken', name: 'A-故障渠道', group: 'A', provider: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORTS.aBroken}/v1`, apiKey: 'k', models: ['deepseek-chat', 'glm-4.6'], weight: 100, priority: 5, cooldown: { baseSec: 60, maxSec: 900, failThreshold: 2 } },
      { id: 'a-fast', name: 'A-快速渠道', group: 'A', provider: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORTS.aFast}/v1`, apiKey: 'k', models: ['deepseek-chat', 'glm-4.6'], weight: 100, priority: 10 },
      { id: 'a-slow', name: 'A-慢渠道', group: 'A', provider: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORTS.aSlow}/v1`, apiKey: 'k', models: ['deepseek-chat'], weight: 10, priority: 20 },
      { id: 'b-free', name: 'B-免费渠道', group: 'B', provider: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORTS.bFree}/v1`, apiKey: 'k', models: ['qwen-turbo', 'deepseek-chat'], weight: 100, priority: 50 },
      { id: 'c-high', name: 'C-高配渠道', group: 'C', provider: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORTS.cHigh}/v1`, apiKey: 'k', models: ['gpt-4o', 'claude-opus-4'], weight: 100, priority: 10 },
    ],
    routes: {},
    tokens: [],
    fallback: { enabled: true, chain: ['A', 'B'] },
    cache: { enabled: true, ttlSec: 600, maxEntries: 100 },
    pricing: { 'deepseek-chat': { in: 0.27, out: 1.1 } },
  };

  const config = normalize(doc, path.join(__dirname, '..'));
  const gw = new GatewayServer(config);
  await gw.start();
  console.log(`\n网关已启动：http://127.0.0.1:${GW_PORT}\n`);

  // ---------------------------------------------------------------- T1
  console.log('[T1] 非流式请求 + 故障渠道自动切换');
  let r = await chat('deepseek-chat');
  if (r.status !== 200) {
    console.log('    [DEBUG] status=' + r.status);
    console.log('    [DEBUG] headers=' + JSON.stringify(r.headers));
    console.log('    [DEBUG] body=' + r.text.slice(0, 400));
  }
  ok('返回 200', r.status === 200, `实际 ${r.status}`);
  ok('跳过了故障渠道，落到 a-fast', r.headers['x-gw-channel'] === 'a-fast', `实际 ${r.headers['x-gw-channel']}`);
  ok('响应体来自 mock', /MOCK:a-fast/.test(r.text), r.text.slice(0, 120));
  let j = JSON.parse(r.text);
  ok('usage 正常透传', j.usage && j.usage.prompt_tokens === 10, JSON.stringify(j.usage));

  // ---------------------------------------------------------------- T2
  console.log('\n[T2] 流式 SSE 透传（零缓冲）');
  r = await request(GW_PORT, '/v1/chat/completions', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  ok('返回 200', r.status === 200, `实际 ${r.status}`);
  ok('content-type 为 text/event-stream', /text\/event-stream/.test(r.headers['content-type'] || ''), r.headers['content-type']);
  ok('收到完整 SSE（含 [DONE]）', r.text.includes('data: [DONE]'), r.text.slice(0, 200));
  ok('收到多个 data 分片', (r.text.match(/^data: /gm) || []).length >= 4, String((r.text.match(/^data: /gm) || []).length));
  ok('首字节延迟 < 1000ms', r.ttfbMs < 1000, `${r.ttfbMs}ms`);

  // ---------------------------------------------------------------- T3
  console.log('\n[T3] 冷却机制：连续失败后渠道被摘除');
  let st = await request(GW_PORT, '/__gw/api/status', { method: 'GET' });
  let stj = JSON.parse(st.text);
  const broken = stj.channels.find((c) => c.id === 'a-broken');
  ok('a-broken 已进入冷却', broken.cooldownRemainSec > 0, `剩余 ${broken.cooldownRemainSec}s`);
  ok('a-broken 标记为不健康', broken.healthy === false, String(broken.healthy));

  // ---------------------------------------------------------------- T4
  console.log('\n[T4] A 组全挂 → 自动降级 B 组');
  await request(GW_PORT, '/__gw/api/channel/toggle', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'a-fast', enabled: false }) });
  await request(GW_PORT, '/__gw/api/channel/toggle', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'a-slow', enabled: false }) });
  // 用唯一内容避免命中前面请求留下的缓存
  r = await request(GW_PORT, '/v1/chat/completions', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: '降级测试-' + Date.now() }] }),
  });
  ok('降级后仍返回 200', r.status === 200, `实际 ${r.status}`);
  ok('落到 B 组 b-free', r.headers['x-gw-channel'] === 'b-free', `实际 ${r.headers['x-gw-channel']}`);
  await request(GW_PORT, '/__gw/api/channel/toggle', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'a-fast', enabled: true }) });
  await request(GW_PORT, '/__gw/api/channel/toggle', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'a-slow', enabled: true }) });

  // ---------------------------------------------------------------- T5
  console.log('\n[T5] C 组必须显式指定（防误烧钱）');
  r = await chat('gpt-4o');
  ok('未指定时不会进入 C 组', r.status === 503, `实际 ${r.status}`);
  ok('错误码为 no_available_channel', /no_available_channel/.test(r.text), r.text.slice(0, 200));

  r = await chat('gpt-4o', { headers: { 'content-type': 'application/json', 'X-GW-Group': 'C' } });
  ok('显式 X-GW-Group: C 后成功', r.status === 200, `实际 ${r.status}`);
  ok('落到 C 组 c-high', r.headers['x-gw-channel'] === 'c-high', `实际 ${r.headers['x-gw-channel']}`);

  r = await chat('c:gpt-4o', { headers: { 'content-type': 'application/json' } });
  ok('模型前缀 c:gpt-4o 同样生效', r.status === 200, `实际 ${r.status}`);
  ok('前缀写法也落到 c-high', r.headers['x-gw-channel'] === 'c-high', `实际 ${r.headers['x-gw-channel']}`);

  // ---------------------------------------------------------------- T6
  console.log('\n[T6] C 组预算熔断');
  st = await request(GW_PORT, '/__gw/api/status', { method: 'GET' });
  stj = JSON.parse(st.text);
  const cCost = stj.budget.C.dailyUsedUSD;
  ok('C 组已累计成本', cCost > 0, `$${cCost}`);
  r = await chat('gpt-4o', { headers: { 'content-type': 'application/json', 'X-GW-Group': 'C' } });
  ok('超出日预算后返回 429', r.status === 429, `实际 ${r.status}`);
  ok('错误类型为 budget_exceeded', /budget_exceeded/.test(r.text), r.text.slice(0, 200));

  // ---------------------------------------------------------------- T7
  console.log('\n[T7] 响应缓存（确定性请求命中后不再打上游）');
  r = await request(GW_PORT, '/__gw/api/cache/purge', { method: 'POST' });
  ok('清空缓存接口可用', JSON.parse(r.text).ok === true, r.text);

  const cbody = JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: '缓存测试' }], temperature: 0 });
  const c1 = await request(GW_PORT, '/v1/chat/completions', { headers: { 'content-type': 'application/json' }, body: cbody });
  const c2 = await request(GW_PORT, '/v1/chat/completions', { headers: { 'content-type': 'application/json' }, body: cbody });
  ok('第一次未命中缓存', c1.status === 200 && c1.headers['x-gw-cache'] !== 'HIT', `cache=${c1.headers['x-gw-cache']}`);
  ok('第二次命中缓存', c2.status === 200 && c2.headers['x-gw-cache'] === 'HIT', `cache=${c2.headers['x-gw-cache']}`);
  ok('缓存命中也返回正确内容', /MOCK:/.test(c2.text), c2.text.slice(0, 120));

  // ---------------------------------------------------------------- T8
  console.log('\n[T8] 管理接口');
  r = await request(GW_PORT, '/v1/models', { method: 'GET' });
  ok('/v1/models 返回 200', r.status === 200, `实际 ${r.status}`);
  const models = JSON.parse(r.text).data.map((m) => m.id);
  ok('模型列表包含 A/B/C 组模型', models.includes('deepseek-chat') && models.includes('qwen-turbo'), models.join(','));

  r = await request(GW_PORT, '/__gw/api/logs?limit=5', { method: 'GET' });
  const logs = JSON.parse(r.text).logs;
  ok('日志接口返回记录', Array.isArray(logs) && logs.length > 0, String(logs && logs.length));
  ok('日志记录字段完整', logs[0] && logs[0].requestId && logs[0].channelId != null, JSON.stringify(logs[0] || {}).slice(0, 160));

  r = await request(GW_PORT, '/__gw/', { method: 'GET' });
  ok('状态页可访问', r.status === 200 && /<html/i.test(r.text), `status=${r.status} len=${r.text.length}`);

  // ---------------------------------------------------------------- T9
  console.log('\n[T9] 用量统计');
  st = await request(GW_PORT, '/__gw/api/status', { method: 'GET' });
  stj = JSON.parse(st.text);
  ok('今日请求数已累计', stj.usage.today.requests >= 5, String(stj.usage.today.requests));
  ok('按组统计存在', stj.usage.byGroup && stj.usage.byGroup.A != null, JSON.stringify(Object.keys(stj.usage.byGroup || {})));
  ok('分组健康度正确计算', stj.groups.A.total === 3 && stj.groups.A.healthy >= 1, JSON.stringify(stj.groups.A));

  // ---------------------------------------------------------------- T10
  console.log('\n[T10] 性能：真实转发的网关开销（每次内容不同，绕开缓存）');
  const t0 = Date.now();
  const N = 30;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      request(GW_PORT, '/v1/chat/completions', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'perf-' + i + '-' + Date.now() }] }),
      })
    )
  );
  const elapsed = Date.now() - t0;
  const perReq = elapsed / N;
  const allOk = results.every((x) => x.status === 200);
  ok(`并发 ${N} 请求全部成功`, allOk, `失败 ${results.filter((x) => x.status !== 200).length} 个`);
  ok(`平均 ${perReq.toFixed(1)}ms/请求（含全部逻辑）`, perReq < 500, `${perReq.toFixed(1)}ms`);

  // 对比：直连上游的基准耗时
  const tBase = Date.now();
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      request(MOCK_PORTS.aFast, '/chat/completions', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'perf-' + i }] }),
      })
    )
  );
  const basePer = (Date.now() - tBase) / N;
  console.log(`    （基准：直连上游平均 ${basePer.toFixed(1)}ms/请求，网关引入约 ${(perReq - basePer).toFixed(1)}ms）`);

  // ---------------------------------------------------------------- T11
  console.log('\n[T11] 渠道在线增删改（页面可编辑 + 热更新）');

  // 11.1 列表接口
  r = await request(GW_PORT, '/__gw/api/channels', { method: 'GET' });
  let cj = JSON.parse(r.text);
  ok('渠道列表接口可用', cj.ok === true && Array.isArray(cj.channels), r.text.slice(0, 160));
  ok('返回全部 5 个渠道', cj.channels.length === 5, String(cj.channels.length));
  ok('渠道来源已切到 store（T4 的启用/停用已落盘）', cj.source === 'store', String(cj.source));
  ok('列表不下发明文密钥字段', cj.channels.every((c) => c.apiKey === undefined), '仍存在 apiKey 字段');
  ok('提供 hasApiKey / apiKeyMasked', cj.channels.every((c) => typeof c.hasApiKey === 'boolean' && typeof c.apiKeyMasked === 'string'), '字段缺失');

  // 11.2 新增渠道
  const SECRET = 'sk-added-1234567890';
  r = await request(GW_PORT, '/__gw/api/channel/save', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      channel: {
        id: 'a-added', name: '新增测试渠道', group: 'A', provider: 'openai', plan: 'standard',
        baseUrl: `http://127.0.0.1:${MOCK_PORTS.aFast}/v1`, apiKey: SECRET,
        models: ['brand-new-model'], weight: 100, priority: 1, enabled: true,
      },
    }),
  });
  let sj = JSON.parse(r.text);
  ok('新增渠道成功', sj.ok === true && sj.created === true, r.text.slice(0, 200));
  ok('返回体中不含明文 Key', !r.text.includes(SECRET), '明文泄漏');
  ok('返回掩码形态', sj.channel && /^.{4}\*{4}.{4}$/.test(sj.channel.apiKeyMasked), sj.channel && sj.channel.apiKeyMasked);

  // 11.3 热更新：不重启进程，新增渠道立刻可路由
  r = await chatFresh('brand-new-model', 'reload');
  ok('新增渠道立即可用（无需重启）', r.status === 200 && r.headers['x-gw-channel'] === 'a-added', `status=${r.status} channel=${r.headers['x-gw-channel']}`);

  // 11.4 局部更新：没提交的字段不能被清空
  r = await request(GW_PORT, '/__gw/api/channel/save', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ originalId: 'a-added', channel: { id: 'a-added', name: '改名后的渠道', weight: 42 } }),
  });
  sj = JSON.parse(r.text);
  ok('局部更新成功（created=false）', sj.ok === true && sj.created === false, r.text.slice(0, 200));
  ok('未提交字段保持不变', sj.channel && sj.channel.priority === 1 && sj.channel.models.includes('brand-new-model'), JSON.stringify(sj.channel && { p: sj.channel.priority, m: sj.channel.models }));
  ok('已提交字段确实改了', sj.channel && sj.channel.weight === 42 && sj.channel.name === '改名后的渠道', JSON.stringify(sj.channel && { w: sj.channel.weight, n: sj.channel.name }));
  ok('留空 apiKey 不会清掉原密钥', sj.channel && sj.channel.hasApiKey === true, '密钥被清空');

  // 11.5 改 id
  r = await request(GW_PORT, '/__gw/api/channel/save', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ originalId: 'a-added', channel: { id: 'a-renamed', name: '改名后的渠道' } }),
  });
  sj = JSON.parse(r.text);
  ok('id 改名成功', sj.ok === true && sj.channel.id === 'a-renamed', r.text.slice(0, 200));
  r = await chatFresh('brand-new-model', 'rename');
  ok('改名后路由仍然可用', r.status === 200 && r.headers['x-gw-channel'] === 'a-renamed', `channel=${r.headers['x-gw-channel']}`);

  // 11.6 连通性测试
  r = await request(GW_PORT, '/__gw/api/channel/test', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'a-renamed' }),
  });
  let tj = JSON.parse(r.text);
  ok('连通性测试通过（HTTP 200 且 ok=true）', r.status === 200 && tj.ok === true, JSON.stringify(tj).slice(0, 200));
  ok('测试返回耗时与探法', typeof tj.latencyMs === 'number' && !!tj.via, JSON.stringify(tj).slice(0, 160));

  // 11.7 ${ENV_VAR} 不被固化成明文
  process.env.TEST_GW_KEY = 'expanded-secret-abc';
  r = await request(GW_PORT, '/__gw/api/channel/save', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      channel: {
        id: 'b-envkey', name: 'env 密钥渠道', group: 'B', provider: 'openai',
        baseUrl: `http://127.0.0.1:${MOCK_PORTS.bFree}/v1`, apiKey: '${TEST_GW_KEY}',
        models: ['env-key-model'], enabled: true,
      },
    }),
  });
  ok('env 引用形式保存成功', JSON.parse(r.text).ok === true, r.text.slice(0, 200));
  const storeFile = path.join(DATA_DIR, 'channels.json');
  const storeText = fs.readFileSync(storeFile, 'utf8');
  ok('落盘保留 ${TEST_GW_KEY} 原样', storeText.includes('${TEST_GW_KEY}'), '引用被替换掉了');
  ok('落盘不含展开后的明文', !storeText.includes('expanded-secret-abc'), '明文被写进了渠道库');
  const envCh = gw.config.channels.find((c) => c.id === 'b-envkey');
  ok('运行时取到的是展开后的真实 Key', envCh && envCh.apiKey === 'expanded-secret-abc', envCh && envCh.apiKey);

  // 11.8 非法渠道被拦住，且不破坏现有渠道
  const countBefore = gw.config.channels.length;
  r = await request(GW_PORT, '/__gw/api/channel/save', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: { id: 'a-bad', name: '坏渠道', group: 'Z', baseUrl: 'not-a-url' } }),
  });
  ok('非法渠道被拒绝（400）', r.status === 400 && JSON.parse(r.text).ok === false, r.text.slice(0, 200));
  ok('校验失败不影响现有渠道', gw.config.channels.length === countBefore, `${countBefore} → ${gw.config.channels.length}`);

  // 11.9 删除
  r = await request(GW_PORT, '/__gw/api/channel/delete', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'a-renamed' }),
  });
  ok('删除成功', r.status === 200 && JSON.parse(r.text).deleted === 'a-renamed', r.text.slice(0, 160));
  r = await chatFresh('brand-new-model', 'deleted');
  ok('删除后该模型不再可用', r.status === 503, `实际 ${r.status}`);

  // 11.10 meta（新增表单所需的模板数据）
  r = await request(GW_PORT, '/__gw/api/meta', { method: 'GET' });
  const mj = JSON.parse(r.text);
  ok('meta 接口可用', mj.ok === true, r.text.slice(0, 160));
  ok('提供 providers / plans / presets', (mj.providers || []).length > 0 && (mj.plans || []).length > 0 && (mj.presets || []).length > 0, JSON.stringify({ p: (mj.providers || []).length, l: (mj.plans || []).length, s: (mj.presets || []).length }));
  ok('presets 带 baseUrl 与 models', (mj.presets || []).every((p) => p.label && p.baseUrl), '模板字段不全');

  // 11.11 重置回 gateway.yaml 基线
  const resetYaml = path.join(__dirname, 'reset-baseline.yaml');
  fs.writeFileSync(
    resetYaml,
    [
      'server:',
      '  host: 127.0.0.1',
      `  port: ${GW_PORT}`,
      '  dataDir: ./.data',
      '  logLevel: error',
      'channels:',
      '  - id: yaml-base-1',
      '    name: YAML 基线渠道',
      '    group: B',
      '    provider: openai',
      `    baseUrl: http://127.0.0.1:${MOCK_PORTS.bFree}/v1`,
      '    apiKey: k',
      '    models: [qwen-turbo]',
      '',
    ].join('\n'),
    'utf8'
  );
  gw.configPath = resetYaml;
  r = await request(GW_PORT, '/__gw/api/channel/reset', { method: 'POST' });
  const rj = JSON.parse(r.text);
  ok('重置接口成功', r.status === 200 && rj.ok === true, r.text.slice(0, 200));
  ok('渠道数回到 YAML 基线的 1 个', gw.config.channels.length === 1, String(gw.config.channels.length));
  ok('渠道库文件已移除', !fs.existsSync(storeFile), '文件仍在');
  ok('来源标记回退为 yaml', rj.source === 'yaml', String(rj.source));
  r = await chatFresh('qwen-turbo', 'reset');
  ok('重置后按 YAML 基线路由', r.status === 200 && r.headers['x-gw-channel'] === 'yaml-base-1', `channel=${r.headers['x-gw-channel']}`);
  try {
    fs.unlinkSync(resetYaml);
  } catch (_) {}

  // ---------------------------------------------------------------- T12
  console.log('\n[T12] 一键获取模型列表 / 模型列表为空也能测连通性');

  const jpost = (p, obj) =>
    request(GW_PORT, p, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

  // 12.1 上游返回的模型清单能被完整取回（表单里还没保存的渠道也要能查）
  r = await jpost('/__gw/api/models/fetch', {
    channel: { id: 't-fetch-new', group: 'B', provider: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORTS.aFast}/v1`, apiKey: 'k' },
  });
  let fj = JSON.parse(r.text);
  ok('未保存的渠道也能获取模型列表', fj.ok === true && fj.count === 3, r.text.slice(0, 220));
  ok(
    '返回的模型名正确',
    Array.isArray(fj.models) && fj.models.includes('deepseek-chat') && fj.models.includes('deepseek-reasoner'),
    JSON.stringify(fj.models)
  );
  ok('返回耗时与来源探法', typeof fj.latencyMs === 'number' && fj.via === 'GET /models', JSON.stringify({ ms: fj.latencyMs, via: fj.via }));

  // 12.2 关键回归：模型列表为空时，连通性测试必须仍然可用
  //     （这正是用户被卡住的地方 —— 前端原先强制要求先填模型名，
  //       但要填模型名就得先知道有哪些模型，形成死循环）
  r = await jpost('/__gw/api/channel/save', {
    channel: {
      id: 't-empty-models', name: '空模型列表渠道', group: 'B', provider: 'openai',
      baseUrl: `http://127.0.0.1:${MOCK_PORTS.aFast}/v1`, apiKey: 'k', models: [],
    },
  });
  ok('允许保存「模型列表为空」的渠道（语义 = 接受任意模型名）', JSON.parse(r.text).ok === true, r.text.slice(0, 200));

  r = await jpost('/__gw/api/channel/test', { id: 't-empty-models' });
  let tj2 = JSON.parse(r.text);
  ok('模型列表为空时连通性测试仍然通过', tj2.ok === true, r.text.slice(0, 220));
  ok('并且顺带把模型清单带回来了', Array.isArray(tj2.models) && tj2.models.length === 3, JSON.stringify(tj2.models || null));

  // 12.3 Gemini 那种 models:[{name:'models/xxx'}] 的形状也要能解析
  r = await jpost('/__gw/api/models/fetch', {
    channel: { id: 't-gemini', group: 'C', provider: 'gemini', baseUrl: `http://127.0.0.1:${MOCK_PORTS.gemini}/v1`, apiKey: 'k' },
  });
  fj = JSON.parse(r.text);
  ok('Gemini 形状的 /models 能解析出模型名', fj.ok === true && fj.models.includes('gemini-2.5-pro'), r.text.slice(0, 220));
  ok('自动剥掉 models/ 前缀', !fj.models.some((m) => m.startsWith('models/')), JSON.stringify(fj.models));

  // 12.4 上游没有 /models：要给出可执行的提示，而不是含糊报错
  r = await jpost('/__gw/api/models/fetch', {
    channel: { id: 't-nomodels', group: 'B', provider: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORTS.noModels}/v1`, apiKey: 'k' },
  });
  fj = JSON.parse(r.text);
  ok('上游没有 /models 时返回 ok:false 且 HTTP 200（不抛错）', r.status === 200 && fj.ok === false, r.text.slice(0, 200));
  ok('提示里带上真实状态码 404', /404/.test(fj.message), fj.message);
  ok('提示是可执行的（告诉用户手动填模型名）', /手动填|不支持|没有/.test(fj.message), fj.message);

  // 12.5 连不上时快速给结论
  const tDead = Date.now();
  r = await jpost('/__gw/api/models/fetch', {
    channel: { id: 't-dead', group: 'B', provider: 'openai', baseUrl: `http://127.0.0.1:${DEAD_PORT}/v1`, apiKey: 'k' },
  });
  const deadMs = Date.now() - tDead;
  ok('地址连不上时快速失败（<5s）', deadMs < 5000, `${deadMs}ms`);
  ok('连不上时不谎报成功', JSON.parse(r.text).ok === false, r.text.slice(0, 200));

  // 12.6 核心回归：探测超时后**不得**再发起第二次慢请求
  //     旧实现是「/models 最长 15s 超时 → 再发一次最长 20s 对话请求」＝ 35s，
  //     用户看到的就是点了按钮一直转圈。
  const tHang = Date.now();
  r = await jpost('/__gw/api/channel/test', {
    channel: {
      id: 't-hang', group: 'B', provider: 'openai',
      baseUrl: `http://127.0.0.1:${MOCK_PORTS.hang}/v1`, apiKey: 'k', models: ['deepseek-chat'],
    },
  });
  const hangMs = Date.now() - tHang;
  const hj = JSON.parse(r.text);
  ok('上游挂起时在探测超时后立刻返回（<13s，不串第二次请求）', hangMs < 13000, `${hangMs}ms`);
  ok('超时如实报错', hj.ok === false && /超时/.test(hj.message), r.text.slice(0, 200));

  // 12.7 收尾：清掉本轮造的测试渠道
  for (const id of ['t-empty-models']) {
    await jpost('/__gw/api/channel/delete', { id });
  }

  // ---------------------------------------------------------------- T13
  console.log('\n[T13] 管理面登录 + 客户端令牌鉴权');
  const AUTH_PORT = GW_PORT + 1;
  const AUTH_PW = 'smoke-test-password';
  const AUTH_TOKEN = 'sk-gw-smoke-token';
  const AUTH_DATA = path.join(__dirname, '.data-auth');

  const authDoc = JSON.parse(JSON.stringify(doc));
  authDoc.server.port = AUTH_PORT;
  authDoc.server.dataDir = './test/.data-auth';
  authDoc.server.auth = {
    enabled: true,
    username: 'admin',
    password: AUTH_PW,
    sessionTtlSec: 3600,
    maxFailures: 3,
    failureWindowSec: 60,
  };
  authDoc.tokens = [{ key: AUTH_TOKEN, name: 'smoke', allowGroups: ['A', 'B', 'C'] }];
  const authGw = new GatewayServer(normalize(authDoc, path.join(__dirname, '..')));
  await authGw.start();

  const apath = (p, o) => request(AUTH_PORT, p, o);
  const form = (body) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });

  // 13.1 未登录：页面跳转、接口 401
  r = await apath('/__gw/', { method: 'GET' });
  ok('未登录访问状态页 → 302 跳登录页', r.status === 302 && String(r.headers.location).startsWith('/__gw/login'), `${r.status} ${r.headers.location}`);
  r = await apath('/__gw/api/status', { method: 'GET' });
  ok('未登录调管理接口 → 401 且带 needLogin', r.status === 401 && JSON.parse(r.text).needLogin === true, `${r.status} ${r.text.slice(0, 80)}`);

  // 13.2 登录页
  r = await apath('/__gw/login', { method: 'GET' });
  ok('登录页可访问并渲染出表单', r.status === 200 && /<form/.test(r.text) && /name="password"/.test(r.text), `HTTP ${r.status}`);
  ok('登录页不引用任何外部资源', !/(src|href)=["'](https?:|\/\/)/.test(r.text));

  // 13.3 密码校验
  r = await apath('/__gw/login', form('username=admin&password=definitely-wrong'));
  ok('密码错误 → 401 且给出提示', r.status === 401 && /不正确/.test(r.text), `HTTP ${r.status}`);

  r = await apath('/__gw/login', form('username=admin&password=' + encodeURIComponent(AUTH_PW)));
  const setCookie = String(r.headers['set-cookie'] || '');
  ok('密码正确 → 302 并下发会话 Cookie', r.status === 302 && /gw_sid=/.test(setCookie), `HTTP ${r.status}`);
  ok('会话 Cookie 带 HttpOnly + SameSite', /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), setCookie.slice(0, 90));
  const sid = setCookie.split(';')[0];

  // 13.4 带会话访问
  r = await apath('/__gw/api/status', { method: 'GET', headers: { cookie: sid } });
  const authSt = JSON.parse(r.text);
  ok('带会话调管理接口 → 200', r.status === 200 && authSt.ok === true, `HTTP ${r.status}`);
  ok('状态接口回传登录用户', authSt.admin && authSt.admin.loginEnabled === true && authSt.admin.user === 'admin', JSON.stringify(authSt.admin));
  r = await apath('/__gw/', { method: 'GET', headers: { cookie: sid } });
  ok('带会话可打开状态页', r.status === 200 && /统一 API 网关/.test(r.text), `HTTP ${r.status}`);

  // 13.5 开放重定向防护
  r = await apath('/__gw/login', form('username=admin&password=' + encodeURIComponent(AUTH_PW) + '&next=' + encodeURIComponent('//evil.example.com')));
  ok('登录后的跳转不会跑到站外', r.status === 302 && !/evil\.example\.com/.test(String(r.headers.location)), String(r.headers.location));

  // 13.6 退出后会话立即失效
  r = await apath('/__gw/logout', { method: 'GET', headers: { cookie: sid } });
  ok('退出 → 302 回登录页', r.status === 302 && r.headers.location === '/__gw/login', String(r.headers.location));
  r = await apath('/__gw/api/status', { method: 'GET', headers: { cookie: sid } });
  ok('退出后旧会话立即失效', r.status === 401, `HTTP ${r.status}`);

  // 13.7 数据面令牌
  r = await apath('/v1/models', { method: 'GET' });
  ok('不带令牌调 /v1 → 401', r.status === 401, `HTTP ${r.status}`);
  r = await apath('/v1/models', { method: 'GET', headers: { authorization: 'Bearer totally-wrong' } });
  ok('令牌错误 → 401', r.status === 401, `HTTP ${r.status}`);
  r = await apath('/v1/models', { method: 'GET', headers: { authorization: 'Bearer ' + AUTH_TOKEN } });
  ok('令牌正确 → 200', r.status === 200, `HTTP ${r.status}`);

  // 13.8 登录后的写操作要能通过（确认闸门只挡未登录，不影响正常使用）
  //      注意：13.6 已经登出，这里必须重新拿一个会话，别用失效的旧 Cookie。
  r = await apath('/__gw/login', form('username=admin&password=' + encodeURIComponent(AUTH_PW)));
  const sid2 = String(r.headers['set-cookie'] || '').split(';')[0];
  r = await apath('/__gw/api/channel/test', {
    headers: { 'content-type': 'application/json', cookie: sid2 },
    body: JSON.stringify({ channel: { id: 't-m', group: 'A', provider: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORTS.aFast}/v1`, apiKey: 'k' } }),
  });
  ok('登录后的管理写操作可正常执行（闸门不误伤）', JSON.parse(r.text).ok === true, r.text.slice(0, 160));

  // 13.9 暴力破解限速（放最后：触发后本机 IP 会被临时拒绝）
  let got429 = false;
  for (let i = 0; i < 8; i++) {
    const rr = await apath('/__gw/login', form('username=admin&password=brute-' + i));
    if (rr.status === 429) { got429 = true; break; }
  }
  ok('连续失败达上限后触发 429 限速', got429);

  authGw.stop();
  if (fs.existsSync(AUTH_DATA)) fs.rmSync(AUTH_DATA, { recursive: true, force: true });

  console.log('\n[T13b] 登录/配置层的独立校验');
  const a = new Auth({ enabled: true, username: 'admin', password: 'p@ss', sessionTtlSec: 60, maxFailures: 2, failureWindowSec: 1 });
  ok('Auth 能识别正确账号密码', a.verify('admin', 'p@ss') === true);
  ok('Auth 拒绝错误密码', a.verify('admin', 'nope') === false);
  ok('Auth 拒绝错误用户名', a.verify('root', 'p@ss') === false);
  ok('未开启时一律不通过', new Auth({ enabled: false, username: 'a', password: 'b' }).verify('a', 'b') === false);

  // 裸奔闸门：非本机监听 + 无令牌 + 无登录 → 必须拒绝加载配置
  let naked = null;
  try {
    normalize({ server: { host: '0.0.0.0' }, channels: doc.channels, groups: doc.groups, tokens: [] }, path.join(__dirname, '..'));
  } catch (e) {
    naked = e.message;
  }
  ok('对外监听且无任何鉴权时拒绝启动', !!naked && /tokens/.test(naked) && /auth/.test(naked), String(naked).slice(0, 120));

  // 登录功能开启但密码为空 → 同样必须拒绝
  let nopw = null;
  try {
    normalize({
      server: { host: '127.0.0.1', auth: { enabled: true, password: '' } },
      channels: doc.channels, groups: doc.groups, tokens: [],
    }, path.join(__dirname, '..'));
  } catch (e) {
    nopw = e.message;
  }
  ok('开了登录却没设密码时拒绝启动', !!nopw && /密码/.test(nopw), String(nopw).slice(0, 120));

  // ---------------------------------------------------------------- T14
  console.log('\n[T14] 渠道自定义请求头转发（复刻 OpenCode Go 的 x-opencode-session）');
  // 不依赖前序测试留下的状态：先把目标渠道建好，再把其它渠道全部停用，
  // 保证「deepseek-chat 一定落到 t-needs-header」。
  const hdrChannel = {
    id: 't-needs-header', name: '需要会话头的渠道', group: 'A', provider: 'openai',
    baseUrl: `http://127.0.0.1:${MOCK_PORTS.headerRequired}/v1`, apiKey: 'k',
    models: ['deepseek-chat'], headers: { 'x-opencode-session': 'gw-test-session' }, priority: 1,
  };
  r = await jpost('/__gw/api/channel/save', { channel: hdrChannel });
  ok('保存带自定义头的渠道', JSON.parse(r.text).ok === true, r.text.slice(0, 140));

  // 界面表单里没有「自定义请求头」这一项，保存时不会提交 headers。
  // 后端必须是「没传就沿用旧值」，否则用户在页面上改个权重就会把这个头一起冲掉，
  // 渠道立刻开始 400 —— 这是会真实发生的事故（OpenCode Go 就靠这个头），单独立一条盯住。
  r = await jpost('/__gw/api/channel/save', {
    channel: { id: hdrChannel.id, name: '在页面上改过名字', weight: 42 },
  });
  ok('界面式局部保存成功（表单不提交 headers 字段）', JSON.parse(r.text).ok === true, r.text.slice(0, 140));
  const keptHdr = (gw.config.channels.find((c) => c.id === hdrChannel.id) || {}).headers || {};
  ok(
    '页面保存后自定义请求头仍在（没被表单冲掉）',
    keptHdr['x-opencode-session'] === 'gw-test-session',
    JSON.stringify(keptHdr)
  );

  const allCh = JSON.parse((await request(GW_PORT, '/__gw/api/channels', { method: 'GET' })).text).channels || [];
  for (const c of allCh) {
    if (c.id !== 't-needs-header') await jpost('/__gw/api/channel/toggle', { id: c.id, enabled: false });
  }
  ok('其它渠道已全部停用，路由只剩目标渠道', gw.config.channels.filter((c) => c.enabled).length === 1,
     gw.config.channels.filter((c) => c.enabled).map((c) => c.id).join(','));

  r = await chatFresh('deepseek-chat', 'hdr-on');
  ok(
    '渠道里配的请求头被真的转发到上游（否则 mock 直接 400）',
    r.status === 200 && r.headers['x-gw-channel'] === 't-needs-header',
    `${r.status} chan=${r.headers['x-gw-channel']} ${r.text.slice(0, 140)}`
  );

  // 反证：同一上游、同一渠道，只把 headers 拿掉就必须被拒 —— 证明前面那次成功是网关加的
  r = await jpost('/__gw/api/channel/save', { channel: Object.assign({}, hdrChannel, { headers: {} }) });
  ok('改渠道配置（清空 headers）成功', JSON.parse(r.text).ok === true, r.text.slice(0, 140));
  r = await chatFresh('deepseek-chat', 'hdr-off');
  ok('清空后上游确实拒绝（反证头是网关加的，不是上游不需要）', r.status >= 400, `实际 ${r.status} ${r.text.slice(0, 120)}`);

  // 连通性探测也必须带上渠道自定义头，否则「测试通过」会骗人
  r = await jpost('/__gw/api/channel/test', {
    channel: {
      id: 't-needs-header', group: 'A', provider: 'openai',
      baseUrl: `http://127.0.0.1:${MOCK_PORTS.headerRequired}/v1`, apiKey: 'k',
      models: ['deepseek-chat'], headers: { 'x-opencode-session': 'gw-test-session' },
    },
  });
  ok('连通性测试同样带上渠道自定义头', JSON.parse(r.text).ok === true, r.text.slice(0, 160));

  await jpost('/__gw/api/channel/delete', { id: 't-needs-header' });

  console.log('\n[T14b] .env 加载（真实密钥不进 gateway.yaml）');
  const envDir = path.join(__dirname, '.envtest');
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(
    path.join(envDir, 'gateway.yaml'),
    [
      'server:',
      '  host: 127.0.0.1',
      '  port: 8787',
      '  dataDir: ./data',
      'channels:',
      '  - id: env-chan',
      '    group: A',
      '    baseUrl: https://example.invalid/v1',
      '    apiKey: ${SMOKE_ENV_KEY}',
      '    models: [deepseek-chat]',
      'tokens: []',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(path.join(envDir, '.env'), '# 注释行应被忽略\nSMOKE_ENV_KEY=sk-from-dotenv\nSMOKE_QUOTED="quoted-value"\n', 'utf8');
  delete process.env.SMOKE_ENV_KEY;
  delete process.env.SMOKE_QUOTED;
  const loaded = load(path.join(envDir, 'gateway.yaml'));
  ok('.env 中的变量被读入并展开到 apiKey', loaded.channels[0].apiKey === 'sk-from-dotenv', loaded.channels[0].apiKey);
  ok('落盘引用保留 ${VAR} 原样（不固化明文）', loaded.channels[0].keyRef === '${SMOKE_ENV_KEY}', String(loaded.channels[0].keyRef));
  ok('.env 支持引号包裹的值', process.env.SMOKE_QUOTED === 'quoted-value', String(process.env.SMOKE_QUOTED));
  // 真实环境变量优先于 .env
  process.env.SMOKE_ENV_KEY = 'sk-from-real-env';
  const loaded2 = load(path.join(envDir, 'gateway.yaml'));
  ok('真实环境变量优先于 .env', loaded2.channels[0].apiKey === 'sk-from-real-env', loaded2.channels[0].apiKey);
  delete process.env.SMOKE_ENV_KEY;
  delete process.env.SMOKE_QUOTED;
  fs.rmSync(envDir, { recursive: true, force: true });

  // ---------------------------------------------------------------- T15
  // 这一节盯一个真实事故：gateway.yaml 里写 ${GATEWAY_API_KEY}，
  // 展开后为空时 YAML 变成 "- key:"（后面跟着同级兄弟键）。
  // 老解析器会把兄弟键当成 key 的值 → key 是个对象 → 空值检查漏检 →
  // 客户端令牌变成字符串 "[object Object]"（谁都能猜到）。
  console.log('\n[T15] YAML 空值解析 + 令牌不能凭空生成');

  const seqEmpty = yaml.parse(['tokens:', '  - key: ', '    name: x', '    allowGroups: [A]'].join('\n'));
  ok('序列项 key 为空时，值是 null', seqEmpty.tokens[0].key === null, JSON.stringify(seqEmpty.tokens[0].key));
  ok('空 key 后面的兄弟键不被吞掉', seqEmpty.tokens[0].name === 'x' && Array.isArray(seqEmpty.tokens[0].allowGroups),
    JSON.stringify(seqEmpty.tokens[0]));

  const seqNoSpace = yaml.parse(['tokens:', '  - key:', '    name: x'].join('\n'));
  ok('无尾空格写法同样正确', seqNoSpace.tokens[0].key === null && seqNoSpace.tokens[0].name === 'x',
    JSON.stringify(seqNoSpace.tokens[0]));

  const seqNested = yaml.parse(['tokens:', '  - key:', '      nested: 1', '    name: x'].join('\n'));
  ok('缩进更深时仍按嵌套值解析（没把嵌套能力一起改坏）',
    seqNested.tokens[0].key && seqNested.tokens[0].key.nested === 1 && seqNested.tokens[0].name === 'x',
    JSON.stringify(seqNested.tokens[0]));

  const seqHasValue = yaml.parse(['tokens:', '  - key: abc', '    name: x'].join('\n'));
  ok('正常有值时不受影响', seqHasValue.tokens[0].key === 'abc' && seqHasValue.tokens[0].name === 'x',
    JSON.stringify(seqHasValue.tokens[0]));

  // 配置层：未展开的令牌必须拒绝启动，且提示要提到该填哪个变量
  const badTokDir = path.join(__dirname, '.tokentest');
  fs.mkdirSync(badTokDir, { recursive: true });
  fs.writeFileSync(
    path.join(badTokDir, 'gateway.yaml'),
    [
      'server:',
      '  host: 127.0.0.1',
      '  port: 8787',
      '  dataDir: ./data',
      'channels:',
      '  - id: c1',
      '    group: A',
      '    baseUrl: https://example.invalid/v1',
      '    apiKey: k',
      '    models: [deepseek-chat]',
      'tokens:',
      '  - key: ${SMOKE_MISSING_TOKEN}',
      '    name: 默认客户端密钥',
      '',
    ].join('\n'),
    'utf8'
  );
  delete process.env.SMOKE_MISSING_TOKEN;
  let tokErr = '';
  try {
    load(path.join(badTokDir, 'gateway.yaml'));
  } catch (e) {
    tokErr = e.message;
  }
  ok('令牌引用的变量没填时拒绝启动', tokErr.length > 0, '居然放行了');
  ok('报错里点明是变量没填', /SMOKE_MISSING_TOKEN/.test(tokErr), tokErr.slice(0, 160));

  // 哪怕 YAML 被改成别的对象形状，配置层也必须拦住，不能造出 "[object Object]" 令牌
  let objTokErr = '';
  try {
    normalize(
      {
        server: { host: '127.0.0.1', port: 8787 },
        channels: [{ id: 'c1', group: 'A', baseUrl: 'https://example.invalid/v1', apiKey: 'k', models: ['deepseek-chat'] }],
        tokens: [{ key: { name: 'x' }, name: '脏数据' }],
      },
      badTokDir,
      null,
      {}
    );
  } catch (e) {
    objTokErr = e.message;
  }
  ok('非字符串的令牌一律拒绝（不静默变成 [object Object]）', /tokens\[0\]/.test(objTokErr), objTokErr.slice(0, 160));

  fs.rmSync(badTokDir, { recursive: true, force: true });

  console.log('\n' + '='.repeat(56));
  console.log(`  通过 ${pass} / 失败 ${fail}`);
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
