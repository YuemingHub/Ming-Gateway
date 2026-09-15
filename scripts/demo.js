'use strict';

/**
 * 演示实例：用 mock 上游把网关跑起来，方便本地看状态页效果
 * 运行：node scripts/demo.js
 * 然后打开 http://127.0.0.1:8787/__gw/
 */

const path = require('path');
const fs = require('fs');
const http = require('http');

const { startMock } = require('../test/mock-upstream');
const { normalize } = require('../lib/config');
const { GatewayServer } = require('../lib/server');

const PORT = 8787;

function post(port, p, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => resolve({ status: res.statusCode, text: t }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const dataDir = path.join(__dirname, '..', 'data', 'demo');
  if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });

  await startMock(9901, {
    channelId: 'deepseek-main', mode: 'ok', usage: { prompt_tokens: 128, completion_tokens: 64 },
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
  });
  await startMock(9902, {
    channelId: 'glm-coding', mode: 'ok', delayMs: 120, usage: { prompt_tokens: 256, completion_tokens: 128 },
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4-flash'],
  });
  await startMock(9903, { channelId: 'kimi-broken', mode: 'fail', models: ['moonshot-v1-32k'] });
  await startMock(9904, {
    channelId: 'siliconflow-free', mode: 'ok', usage: { prompt_tokens: 96, completion_tokens: 32 },
    models: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'THUDM/glm-4-9b-chat', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B'],
  });
  await startMock(9905, {
    channelId: 'openai-high', mode: 'ok', usage: { prompt_tokens: 1500, completion_tokens: 800 },
    models: ['gpt-4o', 'gpt-4.1', 'o1', 'o3-mini'],
  });
  // 9906 故意不提供 /models：用来演示「获取模型列表失败」时的提示
  await startMock(9906, { channelId: 'no-models-upstream', mode: 'ok', models: null });

  const doc = {
    server: { host: '127.0.0.1', port: PORT, dataDir: './data/demo', logLevel: 'info', maxRetries: 2 },
    groups: {
      A: { name: '稳定开发组', desc: '日常开发主力，性价比优先，多渠道互备', fallbackTo: ['B'], cache: { enabled: true, ttlSec: 600 } },
      B: { name: '免费消耗组', desc: '免费或极低成本，A 组故障时的兜底', fallbackTo: [], cache: { enabled: true, ttlSec: 3600 } },
      C: {
        name: '高配置组', desc: '昂贵/高配模型，严格控本，永不自动进入', fallbackTo: [], requireExplicit: true,
        limits: { rpm: 20, tpm: 200000, concurrency: 4 },
        budget: { dailyUSD: 5, monthlyUSD: 60 },
        cache: { enabled: true, ttlSec: 7200 },
      },
    },
    channels: [
      { id: 'glm-coding-plan', name: 'GLM Coding Plan（演示）', group: 'A', provider: 'openai', plan: 'coding', baseUrl: 'http://127.0.0.1:9902/v1', apiKey: 'demo', models: ['glm-4.6', 'deepseek-chat'], weight: 120, priority: 5, limits: { concurrency: 2, windowSec: 18000, windowMaxRequests: 400 } },
      { id: 'deepseek-main', name: 'DeepSeek 主账号（演示）', group: 'A', provider: 'openai', plan: 'standard', baseUrl: 'http://127.0.0.1:9901/v1', apiKey: 'demo', models: ['deepseek-chat', 'deepseek-reasoner'], weight: 100, priority: 10 },
      { id: 'kimi-main', name: 'Kimi（演示·故障中）', group: 'A', provider: 'openai', plan: 'standard', baseUrl: 'http://127.0.0.1:9903/v1', apiKey: 'demo', models: ['deepseek-chat'], weight: 60, priority: 30, cooldown: { baseSec: 60, maxSec: 900, failThreshold: 2 } },
      { id: 'siliconflow-free', name: '硅基流动免费（演示）', group: 'B', provider: 'openai', plan: 'free', baseUrl: 'http://127.0.0.1:9904/v1', apiKey: 'demo', models: ['qwen-turbo', 'deepseek-chat'], weight: 100, priority: 50 },
      { id: 'openai-main', name: 'OpenAI 高配（演示）', group: 'C', provider: 'openai', plan: 'standard', baseUrl: 'http://127.0.0.1:9905/v1', apiKey: 'demo', models: ['gpt-4o', 'o1'], weight: 100, priority: 10, limits: { rpm: 20, concurrency: 4 } },
    ],
    routes: {},
    tokens: [],
    fallback: { enabled: true, chain: ['A', 'B'] },
    cache: { enabled: true, ttlSec: 600, maxEntries: 500 },
  };

  const cfg = normalize(doc, path.join(__dirname, '..'));
  const gw = new GatewayServer(cfg);
  await gw.start();

  console.log(`\n  演示网关已启动：http://127.0.0.1:${PORT}`);
  console.log(`  状态页：http://127.0.0.1:${PORT}/__gw/\n`);

  // 造一些演示数据
  console.log('  正在生成演示流量...');
  for (let i = 0; i < 12; i++) {
    await post(PORT, '/v1/chat/completions', { model: 'deepseek-chat', messages: [{ role: 'user', content: '演示请求 ' + i }] });
  }
  for (let i = 0; i < 3; i++) {
    await post(PORT, '/v1/chat/completions', { model: 'glm-4.6', messages: [{ role: 'user', content: '演示请求 glm ' + i }], stream: true });
  }
  for (let i = 0; i < 2; i++) {
    await post(PORT, '/v1/chat/completions', { model: 'c:gpt-4o', messages: [{ role: 'user', content: '演示高配请求 ' + i }] });
  }
  console.log('  演示数据已就绪，浏览器打开状态页即可查看。Ctrl+C 结束。\n');

  process.on('SIGINT', () => {
    gw.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  });
})();
