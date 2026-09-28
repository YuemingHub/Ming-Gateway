'use strict';

/**
 * 自建分组：页面增删分组 + 该组专属 KEY 的端到端验证
 * 运行：node test/group-crud.js
 *
 * 要回答的问题很具体：「目前只有 A B C 三个组，我要自己可以添加的分组」。
 * 页面上多一张卡片不算做到 —— 加完必须同时满足：
 *   1. 能在这一组建渠道（渠道校验认得这个新组，不会报「组未定义」）
 *   2. 拿到一把只走这一组的 KEY，并且真的打到上游、拿到回答
 *   3. 别的组的 KEY 打不到它（按组隔离没有被新功能破坏）
 *   4. 重启后组和 KEY 都还在（data/groups.json 是真源，不是只在内存里）
 *   5. 删不掉内置组，也删不掉下面还挂着渠道的组
 *
 * 「重启后还在」这一段用 reloadFromDisk() 复刻 gateway.js 的 buildConfig 顺序
 * （先叠组、再校验渠道）—— 顺序反了就会误报「组未定义」，那是真实存在的坑。
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

const { startMock } = require('./mock-upstream');
const { normalize, applyStoredGroups, validateChannelList } = require('../lib/config');
const { ChannelStore, GroupStore, toStored } = require('../lib/store');
const { GatewayServer } = require('../lib/server');

const GW_PORT = Number(process.env.GROUP_GW_PORT || 8298);
const M_A = Number(process.env.GROUP_MOCK_A || 9971);
const M_W = Number(process.env.GROUP_MOCK_W || 9972);
const DATA_DIR = path.join(__dirname, '.data-groups');

const TOK_A = 'key-a-only';
const GROUP_NAME = { work: 'WORK', strict: 'STRICT', d: 'D' };

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
  const o = Object.assign({ method: 'POST', headers: {}, body: null, timeout: 15000 }, opts || {});
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: o.method, headers: o.headers, timeout: o.timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            json: (() => {
              try {
                return JSON.parse(Buffer.concat(chunks).toString('utf8'));
              } catch (_) {
                return null;
              }
            })(),
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

function jget(port, pathname) {
  return request(port, pathname, { method: 'GET' });
}

function jpost(pathname, body) {
  return request(GW_PORT, pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body || {} });
}

let seq = 0;
/** 每次内容都不同，绕开响应缓存，确保真的打到上游 */
function chat(token, model, headers) {
  seq++;
  return request(GW_PORT, '/v1/chat/completions', {
    headers: Object.assign({ 'content-type': 'application/json', authorization: `Bearer ${token}` }, headers || {}),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: `group-crud-${seq}-${Date.now()}-${Math.random().toString(36).slice(2)}` }],
    }),
  });
}

function baseDoc() {
  return {
    server: { host: '127.0.0.1', port: GW_PORT, dataDir: './test/.data-groups', logLevel: 'error', adminToken: '' },
    groups: {
      A: { name: '稳定开发组', desc: 't', fallbackTo: ['B'], requireExplicit: false, cache: { enabled: false } },
      B: { name: '免费消耗组', desc: 't', fallbackTo: [], requireExplicit: false, cache: { enabled: false } },
      C: { name: '高配置组', desc: 't', fallbackTo: [], requireExplicit: true, cache: { enabled: false } },
    },
    channels: [
      { id: 'a-ok', name: 'A-主力', group: 'A', provider: 'openai', baseUrl: `http://127.0.0.1:${M_A}/v1`, apiKey: 'k', models: ['deepseek-chat'] },
    ],
    routes: {},
    tokens: [{ key: TOK_A, name: 'A组key', allowGroups: ['A'] }],
    fallback: { enabled: true, chain: ['A', 'B'], crossGroup: false },
    cache: { enabled: false },
  };
}

/**
 * 复刻 gateway.js 的 buildConfig 顺序：先叠加 data/groups.json，再校验 data/channels.json。
 * 顺序颠倒时，写着 group:D 的渠道会被判「组 D 未定义」而整库回退到 YAML —— 这就是重启丢组的原因。
 */
function reloadFromDisk() {
  const fresh = normalize(JSON.parse(JSON.stringify(baseDoc())), path.join(__dirname, '..'));
  const g = applyStoredGroups(fresh, new GroupStore(fresh.server.dataDir).list() || []);
  fresh.groups = g.groups;
  fresh.tokens = g.tokens;
  const storedChannels = new ChannelStore(fresh.server.dataDir).list() || [];
  const v = validateChannelList(storedChannels, fresh);
  return { config: fresh, groups: g.groups, tokens: g.tokens, channelErrors: v.errors, channels: v.channels };
}

async function main() {
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const mocks = [];
  mocks.push(await startMock(M_A, { channelId: 'a-ok', mode: 'ok' }));
  mocks.push(await startMock(M_W, { channelId: 'w-1', mode: 'ok' }));

  const config = normalize(baseDoc(), path.join(__dirname, '..'));
  const gw = new GatewayServer(config);
  await gw.start();

  // ================================================================ 1. 建组
  console.log('\n[1] 新建分组');
  let r = await jpost('/__gw/api/group/save', { key: 'work', name: '工作专用组', desc: '只放公司模型' });
  ok('建组返回 ok', r.status === 200 && r.json && r.json.ok === true, `${r.status} ${(r.text || '').slice(0, 160)}`);
  ok('小写 key 被规范成大写 WORK', r.json && r.json.group === 'WORK', r.json && r.json.group);
  ok('响应不回传 KEY 明文', r.text && !/\"key\"\s*:/.test(r.text), (r.text || '').slice(0, 160));

  const file = path.join(DATA_DIR, 'groups.json');
  ok('data/groups.json 已落盘', fs.existsSync(file), file);
  const storedDoc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { groups: [] };
  const storedWork = (storedDoc.groups || []).find((g) => g.key === 'WORK');
  ok('落盘记录含 WORK 与其专属 KEY', !!storedWork && !!(storedWork.token && storedWork.token.key), JSON.stringify(storedWork || {}));

  const meta = await jget(GW_PORT, '/__gw/api/meta');
  const metaWork = (meta.json.groups || []).find((g) => g.key === 'WORK');
  ok('/api/meta 里 WORK 标记为自建组', !!metaWork && metaWork.builtin === false && metaWork.hasKey === true, JSON.stringify(metaWork));
  ok('/api/meta 里 A 仍是内置组', (meta.json.groups || []).some((g) => g.key === 'A' && g.builtin === true));
  ok('A/B/C 三个内置组一个没少', ['A', 'B', 'C'].every((k) => (meta.json.groups || []).some((g) => g.key === k)));

  let st = await jget(GW_PORT, '/__gw/api/status');
  ok('/api/status 分组从 3 个变成 4 个', Object.keys(st.json.groups).length === 4, Object.keys(st.json.groups).join(','));
  ok('新组初始 0 个渠道', st.json.groups.WORK.total === 0, st.json.groups.WORK && st.json.groups.WORK.total);
  ok('新组没有被自动加进降级链', st.json.policy.fallbackChain.indexOf('WORK') < 0, st.json.policy.fallbackChain.join('→'));
  ok('降级链仍然只有 A → B', st.json.policy.fallbackChain.join('→') === 'A→B', st.json.policy.fallbackChain.join('→'));
  ok('需显式指定的组当前只有 C', st.json.policy.explicitGroups.join(',') === 'C', st.json.policy.explicitGroups.join(','));

  // ================================================================ 2. 专属 KEY
  console.log('\n[2] 这一组专用的 KEY');
  const toks = await jget(GW_PORT, '/__gw/api/tokens');
  const workTok = toks.json.tokens.find((t) => t.fromGroup === 'WORK');
  const WORK_KEY = workTok ? workTok.key : '';
  ok('令牌面板出现 WORK 组专用 KEY', !!workTok && !!WORK_KEY, JSON.stringify((toks.json.tokens || []).map((t) => t.name)));
  ok('它只授权 WORK 一个组', !!workTok && workTok.groups.length === 1 && workTok.groups[0] === 'WORK', workTok && workTok.groups.join(','));
  ok('KEY 形状是 32 位 base64url', /^[A-Za-z0-9_-]{32}$/.test(WORK_KEY), WORK_KEY ? WORK_KEY.length + ' 位' : '空');
  ok('gateway.yaml 里原有令牌没有被冲掉', toks.json.tokens.some((t) => t.key === TOK_A));

  const modelsWithWorkKey = await request(GW_PORT, '/v1/models', {
    method: 'GET',
    headers: { authorization: `Bearer ${WORK_KEY}` },
  });
  // 新组还没有渠道，所以它的 KEY 看到的模型清单必须是空的 ——
  // 若这里能看到 deepseek-chat，说明按组隔离漏了，WORK 的 KEY 蹭到了 A 组的渠道
  ok('空组的 KEY 在 /v1/models 里看不到别的组的模型',
    modelsWithWorkKey.status === 200 && ((modelsWithWorkKey.json && modelsWithWorkKey.json.data) || []).length === 0,
    `${modelsWithWorkKey.status} ${((modelsWithWorkKey.json && modelsWithWorkKey.json.data) || []).map((m) => m.id).join(',')}`);

  // 正对照：同一条断言在 A 组 KEY 上必须是「看得到模型」，否则上面那条「空」只是因为请求根本没发出去
  const modelsWithAKey = await request(GW_PORT, '/v1/models', { method: 'GET', headers: { authorization: `Bearer ${TOK_A}` } });
  const aModelIds = ((modelsWithAKey.json && modelsWithAKey.json.data) || []).map((m) => m.id);
  ok('对照：A 组 KEY 能列到 A 组渠道的模型', modelsWithAKey.status === 200 && aModelIds.includes('deepseek-chat'),
    `${modelsWithAKey.status} ${aModelIds.join(',')}`);

  // ================================================================ 3. 新组建渠道 + 真调用
  console.log('\n[3] 在新组建渠道并真实调用');
  r = await jpost('/__gw/api/channel/save', {
    channel: {
      id: 'w-1', name: 'WORK-主力', group: 'WORK', provider: 'openai',
      baseUrl: `http://127.0.0.1:${M_W}/v1`, apiKey: 'k', models: ['deepseek-chat'],
    },
  });
  ok('渠道可以放进新建的组（校验认得 WORK）', r.status === 200 && r.json && r.json.ok === true, `${r.status} ${(r.text || '').slice(0, 200)}`);

  st = await jget(GW_PORT, '/__gw/api/status');
  const w1 = st.json.channels.find((c) => c.id === 'w-1');
  ok('状态页里这条渠道属于 WORK 且排第 1 位', !!w1 && w1.group === 'WORK' && w1.order === 0, JSON.stringify(w1 && { g: w1.group, o: w1.order }));
  ok('WORK 组计数变成 1', st.json.groups.WORK.total === 1, st.json.groups.WORK && st.json.groups.WORK.total);
  ok('WORK 组在状态页里排在 A/B/C 之后', Object.keys(st.json.groups).join(',') === 'A,B,C,WORK', Object.keys(st.json.groups).join(','));

  const rw = await chat(WORK_KEY, 'deepseek-chat');
  ok('用 WORK 的 KEY 真实调用成功', rw.status === 200, `${rw.status} ${(rw.text || '').slice(0, 160)}`);
  ok('落到 WORK 组的渠道 w-1', rw.headers['x-gw-channel'] === 'w-1', String(rw.headers['x-gw-channel']));
  const content = ((rw.json && rw.json.choices && rw.json.choices[0]) || {}).message || {};
  ok('回答确实来自 WORK 组那个上游', content.content === 'MOCK:w-1', String(content.content));

  const ra = await chat(TOK_A, 'deepseek-chat');
  ok('A 组 KEY 仍然只走 A 组渠道', ra.status === 200 && ra.headers['x-gw-channel'] === 'a-ok', String(ra.headers['x-gw-channel']));

  const rCross = await chat(TOK_A, 'deepseek-chat', { 'x-gw-group': 'WORK' });
  ok('A 组 KEY 越权指定 WORK 被拒（403）', rCross.status === 403, `实际 ${rCross.status}`);

  const rExplicit = await chat(WORK_KEY, 'deepseek-chat', { 'x-gw-group': 'WORK' });
  ok('WORK 的 KEY 显式指定 WORK 正常', rExplicit.status === 200 && rExplicit.headers['x-gw-channel'] === 'w-1', String(rExplicit.headers['x-gw-channel']));

  // ================================================================ 4. 隔离没有被削弱
  console.log('\n[4] 组隔离与「需显式指定」');
  r = await jpost('/__gw/api/group/save', { key: 'strict', name: '严格组', requireExplicit: true });
  ok('建组时可以勾选「需显式指定」', r.status === 200 && r.json && r.json.requireExplicit === true, (r.text || '').slice(0, 160));
  st = await jget(GW_PORT, '/__gw/api/status');
  ok('需显式指定的组现在是 C、STRICT', st.json.policy.explicitGroups.join(',') === 'C,STRICT', st.json.policy.explicitGroups.join(','));

  await jpost('/__gw/api/channel/toggle', { id: 'w-1', enabled: false });
  const rDown = await chat(WORK_KEY, 'deepseek-chat');
  ok('WORK 组全挂时报错，而不是悄悄落到 A 组', rDown.status === 503, `实际 ${rDown.status}`);
  ok('报错类型仍是 no_available_channel', /no_available_channel/.test(JSON.stringify(rDown.json || {})), (rDown.text || '').slice(0, 120));
  await jpost('/__gw/api/channel/toggle', { id: 'w-1', enabled: true });

  // ================================================================ 5. 闸门
  console.log('\n[5] 拒绝的写法');
  r = await jpost('/__gw/api/group/save', { key: 'A', name: '占用内置组' });
  ok('不能新建与内置组同名的组', r.status === 400 && /内置/.test(r.json.error || ''), `${r.status} ${(r.json && r.json.error) || ''}`);
  r = await jpost('/__gw/api/group/save', { key: 'work', name: '重复' });
  ok('重复标识返回 409 而不是静默覆盖', r.status === 409 && /已存在/.test(r.json.error || ''), `${r.status} ${(r.json && r.json.error) || ''}`);
  r = await jpost('/__gw/api/group/save', { key: '1bad', name: '非法' });
  ok('非法标识被拒（首字符必须是字母）', r.status === 400, `${r.status} ${(r.json && r.json.error) || ''}`);
  r = await jpost('/__gw/api/group/save', { key: 'ALL', name: '保留字' });
  ok('保留字 ALL 不能作为组标识', r.status === 400, `${r.status} ${(r.json && r.json.error) || ''}`);
  r = await jpost('/__gw/api/group/save', { key: 'too-long-key-name', name: '太长' });
  ok('超过 12 位的标识被拒', r.status === 400, `${r.status} ${(r.json && r.json.error) || ''}`);

  const beforeCount = (await jget(GW_PORT, '/__gw/api/status')).json.channels.length;
  r = await jpost('/__gw/api/group/delete', { key: 'A' });
  ok('内置分组不能从页面删除', r.status === 400 && /内置/.test(r.json.error || ''), `${r.status} ${(r.json && r.json.error) || ''}`);
  r = await jpost('/__gw/api/group/delete', { key: 'WORK' });
  ok('下面还有渠道的组不能删', r.status === 400 && /还有 1 个渠道/.test(r.json.error || ''), `${r.status} ${(r.json && r.json.error) || ''}`);
  const afterGuard = await jget(GW_PORT, '/__gw/api/status');
  ok('两次失败的删除没有动到现状', afterGuard.json.channels.length === beforeCount && !!afterGuard.json.groups.WORK);
  ok('WORK 的 KEY 在删除失败后仍然可用', (await chat(WORK_KEY, 'deepseek-chat')).status === 200);

  // ================================================================ 6. 删除 + 重启
  console.log('\n[6] 删除分组与重启后仍在');
  await jpost('/__gw/api/channel/delete', { id: 'w-1' });
  r = await jpost('/__gw/api/group/delete', { key: 'WORK' });
  ok('清空渠道后可以删除分组', r.status === 200 && r.json && r.json.ok === true, `${r.status} ${(r.text || '').slice(0, 160)}`);
  st = await jget(GW_PORT, '/__gw/api/status');
  ok('分组列表回到 A/B/C/STRICT', Object.keys(st.json.groups).join(',') === 'A,B,C,STRICT', Object.keys(st.json.groups).join(','));
  const gone = await chat(WORK_KEY, 'deepseek-chat');
  ok('被删分组的 KEY 立刻失效', gone.status === 401, `实际 ${gone.status}`);
  const storedAfterDel = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('groups.json 里 WORK 记录已移除', !(storedAfterDel.groups || []).some((g) => g.key === 'WORK'));

  // 建一个组 + 渠道，专门用来验证「重启后组和 KEY 都还在」
  r = await jpost('/__gw/api/group/save', { key: 'd', name: 'D 组' });
  ok('可以再建第二个自建组', r.status === 200 && r.json.group === 'D', (r.text || '').slice(0, 120));
  r = await jpost('/__gw/api/channel/save', {
    channel: { id: 'd-1', name: 'D-渠道', group: 'D', provider: 'openai', baseUrl: `http://127.0.0.1:${M_W}/v1`, apiKey: 'k', models: ['glm-4.6'] },
  });
  ok('第二个组里能建渠道', r.status === 200 && r.json.ok === true, `${r.status} ${(r.text || '').slice(0, 200)}`);
  const dKey = ((await jget(GW_PORT, '/__gw/api/tokens')).json.tokens.find((t) => t.fromGroup === 'D') || {}).key || '';
  const rdBefore = await chat(dKey, 'glm-4.6');
  ok('D 组 KEY 重启前可用', rdBefore.status === 200 && rdBefore.headers['x-gw-channel'] === 'd-1', `${rdBefore.status} ${rdBefore.headers['x-gw-channel']}`);

  const re = reloadFromDisk();
  ok('重启后 D 组仍然在分组表里', !!re.groups.D && re.groups.D.builtin === false, Object.keys(re.groups).join(','));
  const reKey = (re.tokens.find((t) => t.fromGroup === 'D') || {}).key || '';
  ok('重启后 D 组的 KEY 原样恢复', reKey === dKey && !!reKey);
  ok('重启后写着 group:D 的渠道校验通过（没有「组未定义」）', re.channelErrors.length === 0 && re.channels.some((c) => c.id === 'd-1' && c.group === 'D'),
    re.channelErrors.join('; '));
  ok('重启后 A/B/C 仍标记为内置', !!re.groups.A.builtin && !!re.groups.C.builtin && !!re.groups.C.requireExplicit);
  ok('重启后 C 组的「需显式指定」没有被抹掉', re.groups.C.requireExplicit === true);

  gw.stop();
  mocks.forEach((m) => m.close());
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

  console.log('\n' + '='.repeat(56));
  console.log(`  自建分组：通过 ${pass} / 失败 ${fail}`);
  if (failures.length) {
    console.log('\n  失败明细：');
    failures.forEach((f) => console.log('   - ' + f));
  }
  console.log('='.repeat(56) + '\n');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
