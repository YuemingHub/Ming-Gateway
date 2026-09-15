'use strict';

/**
 * 生产加固回归测试
 * 运行：node test/prod-hardening.js
 *
 * 这一组用例专门盯「上线才会要命」的那类缺陷：
 *   - 资源泄漏（并发槽只借不还，渠道被永久占死）
 *   - 一个畸形请求打挂进程（Promise 没人 catch）
 *   - 请求体上限形同虚设（大 body 直接把内存吃干）
 *   - 伪造 X-Forwarded-For 绕过登录限速
 *   - 不可信输入写进日志造成的日志伪造
 *
 * 每条用例都对应一次真实修复，改动后跑一遍就能确认没有回退。
 * 全部依赖 Node 内置模块，无需安装任何东西。
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

const { startMock } = require('./mock-upstream');
const { normalize } = require('../lib/config');
const { GatewayServer } = require('../lib/server');
const { Auth, clientIp } = require('../lib/auth');

const GW_PORT = Number(process.env.HARDEN_GW_PORT || 8199);
const MOCK_OK = Number(process.env.HARDEN_MOCK_OK || 9831);
const MOCK_FAIL = Number(process.env.HARDEN_MOCK_FAIL || 9832);
const MOCK_DRIP = Number(process.env.HARDEN_MOCK_DRIP || 9833);
const DATA_DIR = path.join(__dirname, '.data-hardening');

/** 请求体上限压到 1MB，方便在测试里构造超限请求（配置下限是 64KB，1MB 不会被钳制改写） */
const MAX_BODY = 1024 * 1024;
const ADMIN_PASSWORD = 'hardening-pw';

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

/** 登录后拿到的会话 Cookie；管理接口开着 auth，必须带上才能通过闸门 */
let SESSION_COOKIE = '';

function request(port, pathname, opts) {
  const o = Object.assign({ method: 'POST', headers: {}, body: null, timeout: 20000 }, opts || {});
  // 管理面路径自动带会话；/v1/* 和 /healthz 不受影响
  const headers = Object.assign({}, o.headers);
  if (SESSION_COOKIE && pathname.startsWith('/__gw')) headers.cookie = SESSION_COOKIE;
  return new Promise((resolve, reject) => {
    const req = http.request(
      // agent: false —— 关闭连接池复用。413 响应带 Connection: close，
      // 服务端会主动关掉这条连接，复用它会在下一次请求撞上 ECONNRESET。
      { host: '127.0.0.1', port, path: pathname, method: o.method, headers, timeout: o.timeout, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (o.body) req.write(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    req.end();
  });
}

function chat(model, bodyOverride) {
  return request(GW_PORT, '/v1/chat/completions', {
    headers: { 'content-type': 'application/json' },
    body: bodyOverride || JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  });
}

async function status() {
  const r = await request(GW_PORT, '/__gw/api/status', { method: 'GET' });
  return JSON.parse(r.text);
}

/** 渠道当前占用的并发槽数（状态页把限流快照放在 runtime 字段里） */
function inflightOf(st, id) {
  const c = (st.channels || []).find((x) => x.id === id);
  return c && c.runtime ? c.runtime.inflight : null;
}

async function main() {
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

  // ---------------------------------------------------------------- 崩溃哨兵
  // 只要有一条用例触发了未捕获异常 / 未处理拒绝，就说明「一个请求打挂进程」的风险回来了
  const crashes = [];
  process.on('unhandledRejection', (e) => crashes.push('unhandledRejection: ' + ((e && e.message) || e)));
  process.on('uncaughtException', (e) => crashes.push('uncaughtException: ' + ((e && e.message) || e)));

  console.log('\n启动 mock 上游...');
  const mocks = [];
  mocks.push(await startMock(MOCK_OK, { channelId: 'ok-probe', mode: 'ok' }));
  mocks.push(await startMock(MOCK_FAIL, { channelId: 'leak-probe', mode: 'fail' }));

  // 「滴流」上游：每 100ms 吐一个字节，永远不结束。
  // 用来验证整体超时 —— 只要它还活着，空闲超时就永远不会触发。
  const dripTimers = new Set();
  const drip = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const t = setInterval(() => res.write('x'), 100);
    dripTimers.add(t);
    const stop = () => {
      clearInterval(t);
      dripTimers.delete(t);
    };
    req.on('close', stop);
    res.on('close', stop);
  });
  await new Promise((r) => drip.listen(MOCK_DRIP, '127.0.0.1', r));
  mocks.push(drip);
  console.log(`  ok=${MOCK_OK} fail=${MOCK_FAIL} drip=${MOCK_DRIP}`);

  const doc = {
    server: {
      host: '127.0.0.1',
      port: GW_PORT,
      dataDir: './test/.data-hardening',
      maxRetries: 0, // 只试一次，保证请求一定落在探针渠道上，便于观察并发计数
      requestTimeoutMs: 8000,
      connectTimeoutMs: 3000,
      logLevel: 'error',
      adminToken: '',
      maxBodyBytes: MAX_BODY,
      auth: { enabled: true, username: 'admin', password: ADMIN_PASSWORD, maxFailures: 3, failureWindowSec: 600, trustProxy: false },
    },
    groups: { A: { name: '加固测试组', desc: 'test', fallbackTo: [], requireExplicit: false } },
    channels: [
      {
        id: 'leak-probe',
        name: '并发泄漏探针',
        group: 'A',
        provider: 'openai',
        baseUrl: `http://127.0.0.1:${MOCK_FAIL}/v1`,
        apiKey: 'k',
        models: ['leak-model'],
        limits: { concurrency: 3, rpm: 0, tpm: 0 },
        priority: 10,
        // 关掉冷却：否则失败两次渠道就被摘除，后面拿不到 500，
        // 也就观察不到「并发槽没归还」这个现象本身
        cooldown: { baseSec: 1, maxSec: 1, failThreshold: 999 },
      },
      {
        id: 'ok-probe',
        name: '正常渠道',
        group: 'A',
        provider: 'openai',
        baseUrl: `http://127.0.0.1:${MOCK_OK}/v1`,
        apiKey: 'k',
        // 同时提供 leak-model：让「先失败后切换」这条路径真的会发生
        models: ['ok-model', 'leak-model'],
        priority: 20,
      },
      {
        id: 'drip-probe',
        name: '慢速滴流渠道',
        group: 'A',
        provider: 'openai',
        baseUrl: `http://127.0.0.1:${MOCK_DRIP}/v1`,
        apiKey: 'k',
        models: ['drip-model'],
        timeoutMs: 1200, // 整体超时 1.2s；滴流上游每 100ms 吐一个字节
      },
    ],
    routes: {},
    tokens: [],
    fallback: { enabled: false, chain: ['A'] },
    cache: { enabled: false },
  };

  const config = normalize(doc, path.join(__dirname, '..'));
  ok('配置里的 maxBodyBytes 被正确读入', config.server.maxBodyBytes === MAX_BODY, String(config.server.maxBodyBytes));

  const gw = new GatewayServer(config);

  // 捕获网关写出的日志，用于验证「不可信输入不会伪造日志行」
  const logs = [];
  const realLog = gw.log.bind(gw);
  gw.log = (lv, m) => {
    logs.push(String(m));
    if (lv === 'error') realLog(lv, m);
  };

  await gw.start();
  console.log(`\n网关已启动：http://127.0.0.1:${GW_PORT}\n`);

  // ---------------------------------------------------------------- H0
  console.log('[H0] 登录闸门');
  {
    const denied = await request(GW_PORT, '/__gw/api/status', { method: 'GET' });
    ok('未登录访问管理接口被拒绝', denied.status === 401, `实际 ${denied.status}`);

    const r = await request(GW_PORT, '/__gw/login', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `username=admin&password=${encodeURIComponent(ADMIN_PASSWORD)}`,
    });
    const setCookie = String(r.headers['set-cookie'] || '');
    ok('登录成功并下发会话 Cookie', /gw_sid=/.test(setCookie), `status=${r.status}`);
    ok('Cookie 带 HttpOnly', /HttpOnly/i.test(setCookie), setCookie);
    ok('Cookie 带 SameSite=Lax', /SameSite=Lax/i.test(setCookie), setCookie);

    SESSION_COOKIE = setCookie.split(';')[0];
    const allowed = await request(GW_PORT, '/__gw/api/status', { method: 'GET' });
    ok('带会话后可以访问管理接口', allowed.status === 200, `实际 ${allowed.status}`);
  }

  // ---------------------------------------------------------------- H1
  console.log('[H1] 并发槽守恒：上游持续报错后不能把渠道占死');
  {
    // 不变式：无论上游返回什么，借走的并发槽最终都要还回去。
    // 探针渠道 concurrency=3，一旦槽不还，第 4 个请求起就会被自己的并发闸门挡住。
    // 探针渠道 concurrency=3。若并发槽泄漏，第 4 个请求起就会被自己的并发闸门挡住（429），
    // 且 inflight 会一直停在 3 —— 修复前正是这个表现。
    const N = 10;
    const statuses = [];
    for (let i = 0; i < N; i++) {
      const r = await chat('leak-model');
      statuses.push(r.status);
    }
    ok(`${N} 个失败请求都拿到了响应（没有被并发闸门卡死）`, statuses.every((s) => s === 500), statuses.join(','));

    const st = await status();
    const inflight = inflightOf(st, 'leak-probe');
    ok('失败请求结束后 inflight 归零（并发槽已归还）', inflight === 0, `实际 ${inflight}`);

    // 归还后必须还能继续服务：再来一轮仍然全 500（说明确实打到上游，而不是被闸门拒了）
    const again = await chat('leak-model');
    ok('归还后渠道仍可继续处理请求', again.status === 500, `实际 ${again.status}`);
  }

  // ---------------------------------------------------------------- H2
  console.log('\n[H2] 切换渠道重试：跳过失败渠道后，它的槽位也要是干净的');
  {
    // 打开重试：leak-probe 先失败，再切到 ok-probe。
    config.server.maxRetries = 1;
    const r = await chat('leak-model');
    ok('重试后最终成功', r.status === 200, `实际 ${r.status}`);
    ok('结果来自 ok-probe', r.headers['x-gw-channel'] === 'ok-probe', String(r.headers['x-gw-channel']));

    const st = await status();
    ok('被跳过的失败渠道并发槽已归还', inflightOf(st, 'leak-probe') === 0, String(inflightOf(st, 'leak-probe')));
    config.server.maxRetries = 0;
  }

  console.log('\n[H2b] 响应写回之后的环节抛异常，不能二次归还并发槽');
  {
    // 借槽 → release() 归还 → 紧接着 usage.record 抛异常 → 进 catch。
    // 若 catch 无条件再还一次，就会把别人的在飞槽位也还掉，并发计数失真。
    const realRecord = gw.record.bind(gw);
    let thrown = false;
    gw.record = () => {
      if (!thrown) {
        thrown = true;
        throw new Error('mock: 用量落盘失败');
      }
      return realRecord.apply(null, arguments);
    };

    const r = await chat('leak-model');
    ok('内部环节抛异常时返回 5xx 而不是崩溃', r.status >= 500, `实际 ${r.status}`);
    gw.record = realRecord;

    const st = await status();
    ok('异常路径后 inflight 仍为 0（没有多还也没有漏还）', inflightOf(st, 'leak-probe') === 0, String(inflightOf(st, 'leak-probe')));

    // 计数没失真 ⇒ 并发闸门仍然有效：连续 10 个请求都能正常拿到响应
    const codes = [];
    for (let i = 0; i < 10; i++) codes.push((await chat('leak-model')).status);
    ok('闸门未被异常污染，后续请求照常处理', codes.every((c) => c === 500), codes.join(','));
  }

  // ---------------------------------------------------------------- H3
  console.log('\n[H3] 请求体超限：返回 413 而不是 500，且进程存活');
  {
    const big = JSON.stringify({ model: 'ok-model', messages: [{ role: 'user', content: 'x'.repeat(MAX_BODY) }] });
    const r = await request(GW_PORT, '/v1/chat/completions', {
      headers: { 'content-type': 'application/json' },
      body: big,
    });
    ok('超大请求体返回 413（不是 500）', r.status === 413, `实际 ${r.status}`);
    ok('错误码是 payload_too_large', /payload_too_large/.test(r.text), r.text.slice(0, 160));

    // 超限后网关必须还活着
    const hz = await request(GW_PORT, '/healthz', { method: 'GET' });
    ok('超限请求之后网关仍然存活', hz.status === 200, `实际 ${hz.status}`);

    // 正常大小的请求不受影响
    const good = await chat('ok-model');
    ok('正常请求不受超限影响', good.status === 200, `实际 ${good.status}`);
  }

  // ---------------------------------------------------------------- H4
  console.log('\n[H4] 管理接口收到超大 / 畸形请求体不能打挂进程');
  {
    const big = JSON.stringify({ id: 'x'.repeat(MAX_BODY * 3) });
    const endpoints = ['/__gw/api/channel/save', '/__gw/api/channel/delete', '/__gw/api/channel/toggle'];
    for (const ep of endpoints) {
      const r = await request(GW_PORT, ep, { headers: { 'content-type': 'application/json' }, body: big });
      ok(`${ep} 超大请求体返回 413`, r.status === 413, `实际 ${r.status}`);
    }

    // 登录接口是表单提交，走的是另一条 readBody 分支，同样不能有漏网的 reject
    const formBody = 'username=' + 'u'.repeat(MAX_BODY * 2) + '&password=p';
    const lr = await request(GW_PORT, '/__gw/login', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody,
    });
    ok('登录接口超大请求体返回 413', lr.status === 413, `实际 ${lr.status}`);

    const hz = await request(GW_PORT, '/healthz', { method: 'GET' });
    ok('连打多个畸形请求后进程依然存活', hz.status === 200, `实际 ${hz.status}`);
  }

  // ---------------------------------------------------------------- H5
  console.log('\n[H5] 非 JSON / 空对象请求体要有明确报错，不能静默 500');
  {
    const r1 = await request(GW_PORT, '/__gw/api/channel/save', {
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    ok('非法 JSON 返回 400', r1.status === 400, `实际 ${r1.status}`);
    ok('提示指明不是合法 JSON', /合法 JSON/.test(r1.text), r1.text.slice(0, 160));

    const r2 = await request(GW_PORT, '/__gw/api/channel/save', {
      headers: { 'content-type': 'application/json' },
      body: '[1,2,3]',
    });
    ok('JSON 数组被拒绝（要求对象）', r2.status === 400, `实际 ${r2.status}`);
  }

  // ---------------------------------------------------------------- H6
  console.log('\n[H6] X-Forwarded-For 不能被客户端伪造');
  {
    const realIp = '9.9.9.9';
    const forged = '1.2.3.4';
    const req = { headers: { 'x-forwarded-for': forged }, socket: { remoteAddress: realIp } };

    ok('trustProxy=false 时忽略 XFF，取真实地址', clientIp(req, false) === realIp, clientIp(req, false));
    ok('trustProxy=true 时才采信 XFF', clientIp(req, true) === forged, clientIp(req, true));
    ok('没有 XFF 时回落到 socket 地址', clientIp({ headers: {}, socket: { remoteAddress: realIp } }, true) === realIp);

    // 伪造 IP 不能绕过登录失败限速：三次失败必须落在同一个真实 IP 上
    const auth = new Auth(
      { enabled: true, username: 'admin', password: 'pw', maxFailures: 3, failureWindowSec: 600, trustProxy: false },
      () => {}
    );
    for (const fake of ['5.5.5.5', '6.6.6.6', '7.7.7.7']) {
      const r = { headers: { 'x-forwarded-for': fake }, socket: { remoteAddress: realIp } };
      auth.noteFailure(clientIp(r, false));
    }
    ok('换着伪造 XFF 也躲不过限速（仍按真实 IP 累计）', auth.blockedFor(realIp) > 0, `blockedFor=${auth.blockedFor(realIp)}`);
    ok('伪造出来的 IP 本身没有污染记录表', auth.blockedFor('5.5.5.5') === 0);
    ok('失败记录表只留了 1 条真实 IP', auth.failures.size === 1, String(auth.failures.size));
  }

  // ---------------------------------------------------------------- H7
  console.log('\n[H7] 失败记录表不能被海量伪造 IP 撑爆');
  {
    const auth = new Auth(
      { enabled: true, username: 'admin', password: 'pw', maxFailures: 1000, failureWindowSec: 600, trustProxy: true },
      () => {}
    );
    // trustProxy=true 是最坏情况：客户端能指定任意 IP。表必须有上限。
    for (let i = 0; i < 12000; i++) {
      auth.noteFailure('10.0.' + (i % 250) + '.' + (i % 254));
    }
    ok('失败记录表条目数被限制在 10000 以内', auth.failures.size <= 10000, String(auth.failures.size));
  }

  // ---------------------------------------------------------------- H8
  console.log('\n[H8] 用户名里的换行不能伪造日志行');
  {
    const before = logs.length;
    await request(GW_PORT, '/__gw/login', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=' + encodeURIComponent('admin\nFAKE LOG LINE 登录成功') + '&password=wrong',
    });
    const added = logs.slice(before);
    const bad = added.filter((m) => m.includes('\n'));
    ok('失败日志里没有换行（输入已被压平）', bad.length === 0, bad[0] || '');
    ok('确实记录了一次登录失败', added.some((m) => /登录失败/.test(m)), JSON.stringify(added));
  }

  // ---------------------------------------------------------------- H9
  console.log('\n[H9] 管理令牌校验');
  {
    // 未配置 adminToken 时该分支整体关闭，任何令牌都不该放行
    ok('未配置 adminToken 时不接受任意令牌', gw.adminTokenOk({ headers: { 'x-admin-token': 'anything' } }) === false);

    config.server.adminToken = 's3cret-token';
    ok('正确的 adminToken 被接受', gw.adminTokenOk({ headers: { 'x-admin-token': 's3cret-token' } }) === true);
    ok('错误的 adminToken 被拒绝', gw.adminTokenOk({ headers: { 'x-admin-token': 'wrong' } }) === false);
    ok('只差一个字符也被拒绝', gw.adminTokenOk({ headers: { 'x-admin-token': 's3cret-toke' } }) === false);
    ok('Authorization: Bearer 形式同样有效', gw.adminTokenOk({ headers: { authorization: 'Bearer s3cret-token' } }) === true);
    config.server.adminToken = '';
  }

  // ---------------------------------------------------------------- H10
  console.log('\n[H10] 慢速上游：整体超时必须真正生效');
  {
    // 上游每 100ms 吐一个字节，永远不停。
    // req.setTimeout 只是空闲超时，100ms 的间隔根本触发不了 ——
    // 没有整体 deadline 的话这个请求会一直挂到客户端超时。
    const t0 = Date.now();
    const r = await chat('drip-model');
    const cost = Date.now() - t0;
    ok('慢速上游被整体超时掐断（不是一直挂着）', r.status >= 500, `实际 ${r.status}`);
    ok(`耗时在超时附近而不是无限等待（${cost}ms）`, cost < 8000, `${cost}ms`);
    ok('超时后返回的是明确的错误响应', /error|超时/.test(r.text), r.text.slice(0, 120));
  }

  // ---------------------------------------------------------------- H11
  console.log('\n[H11] 客户端中途断开：网关不能崩，也不能继续空转');
  {
    const before = crashes.length;
    await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: GW_PORT, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' }, agent: false },
        (res) => {
          res.resume();
          res.on('end', resolve);
        }
      );
      req.on('error', () => resolve()); // 客户端主动断开，报错属预期
      req.write(JSON.stringify({ model: 'drip-model', messages: [{ role: 'user', content: 'abort-me' }] }));
      req.end();
      setTimeout(() => req.destroy(), 300); // 上游还在慢慢吐，客户端先走了
    });

    const hz = await request(GW_PORT, '/healthz', { method: 'GET' });
    ok('客户端断开后网关仍然存活', hz.status === 200, `实际 ${hz.status}`);
    ok('没有因此产生未捕获异常', crashes.length === before, crashes.slice(before).join(' | '));
  }

  // ---------------------------------------------------------------- H12
  console.log('\n[H12] 全程没有未捕获异常 / 未处理拒绝');
  ok('没有触发未捕获异常或未处理拒绝', crashes.length === 0, crashes.join(' | '));

  // ---------------------------------------------------------------- 收尾
  gw.stop();
  for (const t of dripTimers) clearInterval(t);
  for (const m of mocks) {
    try {
      m.close();
    } catch (_) {}
  }

  console.log('\n========================================================');
  console.log(`  生产加固测试：通过 ${pass} / 失败 ${fail}`);
  if (failures.length) {
    console.log('\n  失败明细：');
    for (const f of failures) console.log('   - ' + f);
  }
  console.log('========================================================\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
