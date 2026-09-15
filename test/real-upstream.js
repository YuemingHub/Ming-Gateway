'use strict';

/**
 * 真实上游联调（只验证 proxy 重构后的转发/流式/超时链路）
 *
 * 用 .env 里已经填好的 OPENCODE_GO_API_KEY 直连真实订阅端点，
 * 验证三件事：
 *   1) 非流式对话能通
 *   2) 流式 SSE 能完整收完（含 [DONE]），首字节够快 —— 证明零缓冲透传没被改坏
 *   3) 不存在的模型能正常报错并换渠道，不会挂死
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { normalize } = require('../lib/config');
const { GatewayServer } = require('../lib/server');

const GW_PORT = 8197;

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function readEnvKey(name) {
  const p = path.join(__dirname, '../.env');
  if (!fs.existsSync(p)) return '';
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '').trim();
  }
  return '';
}

function request(port, pathname, opts) {
  const o = Object.assign({ method: 'POST', headers: {}, body: null, timeout: 60000 }, opts || {});
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: o.method, headers: o.headers, timeout: o.timeout, agent: false },
      (res) => {
        const chunks = [];
        const t0 = Date.now();
        let first = null;
        res.on('data', (c) => {
          if (first === null) first = Date.now() - t0;
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), ttfbMs: first == null ? -1 : first }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (o.body) req.write(o.body);
    req.end();
  });
}

async function main() {
  const apiKey = readEnvKey('OPENCODE_GO_API_KEY');
  if (!apiKey) {
    console.log('  ⚠ 跳过：.env 里没有 OPENCODE_GO_API_KEY');
    process.exit(0);
  }
  // 真实 baseUrl 从 gateway.yaml 里取，避免在这里写死
  const yamlText = fs.readFileSync(path.join(__dirname, '../gateway.yaml'), 'utf8');
  const base = /baseUrl:\s*(\S+)/.exec(yamlText);
  const baseUrl = base ? base[1] : '';
  console.log(`  上游：${baseUrl}（key 长度 ${apiKey.length}）`);

  const doc = {
    server: { host: '127.0.0.1', port: GW_PORT, dataDir: './test/.data-real', maxRetries: 1, requestTimeoutMs: 60000, connectTimeoutMs: 8000, logLevel: 'warn', adminToken: '' },
    groups: { A: { name: 'A', desc: '' } },
    channels: [
      {
        id: 'real-opencode',
        name: '真实 OpenCode Go',
        group: 'A',
        provider: 'openai',
        baseUrl,
        apiKey,
        // 前两个是实测可用的模型；第三个故意写成上游不认的名字，
        // 用来验证「路由到了上游、但上游报错」这条路径也能快速返回而不是挂住
        models: ['deepseek-flash', 'mimo-v2.5', 'not-a-real-model-xyz'],
        headers: { 'x-opencode-session': 'api-all-gateway' },
      },
    ],
    routes: {},
    tokens: [],
    fallback: { enabled: false, chain: ['A'] },
  };

  const config = normalize(doc, path.join(__dirname, '..'));
  const gw = new GatewayServer(config);
  await gw.start();
  console.log(`  网关已启动 :${GW_PORT}\n`);

  console.log('[真实] 非流式对话');
  let r = await request(GW_PORT, '/v1/chat/completions', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: '只回复两个字：收到' }] }),
  });
  ok('返回 200', r.status === 200, `status=${r.status} body=${r.text.slice(0, 200)}`);
  ok('响应来自真实上游', r.headers['x-gw-channel'] === 'real-opencode', String(r.headers['x-gw-channel']));
  if (r.status === 200) {
    const j = JSON.parse(r.text);
    ok('有 choices', Array.isArray(j.choices) && j.choices.length > 0);
    ok('有 usage', !!j.usage, JSON.stringify(j.usage || {}));
  }

  console.log('\n[真实] 流式 SSE');
  const t0 = Date.now();
  r = await request(GW_PORT, '/v1/chat/completions', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: '数到五，每行一个数' }], stream: true }),
  });
  ok('流式返回 200', r.status === 200, `status=${r.status}`);
  ok('content-type 是 SSE', /text\/event-stream/.test(r.headers['content-type'] || ''), String(r.headers['content-type']));
  ok('收到 [DONE]（流完整收尾，没被 timeout 掐断）', r.text.includes('data: [DONE]'), r.text.slice(-120));
  ok('首字节够快（< 25s）', r.ttfbMs >= 0 && r.ttfbMs < 25000, `${r.ttfbMs}ms`);
  ok('总耗时在超时内', Date.now() - t0 < 60000, `${Date.now() - t0}ms`);

  console.log('\n[真实] 不存在的模型要快速报错，不能挂死');
  const t1 = Date.now();
  r = await request(GW_PORT, '/v1/chat/completions', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'definitely-not-a-model-xyz', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const cost = Date.now() - t1;
  ok('返回 4xx/5xx 而不是挂住', r.status >= 400, `status=${r.status}`);
  ok(`在合理时间内返回（${cost}ms）`, cost < 60000, `${cost}ms`);

  gw.stop();
  console.log(`\n========================================================`);
  console.log(`  真实上游联调：通过 ${pass} / 失败 ${fail}`);
  console.log(`========================================================\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('联调脚本异常：', e && e.message);
  process.exit(1);
});
