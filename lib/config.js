'use strict';

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const yaml = require('./yaml');
const { isEnvRef } = require('./store');

/**
 * 配置加载与校验
 * 所有默认值在此收敛，后续模块无需再判空。
 */

const DEFAULT_GROUPS = {
  A: { name: '稳定开发组', desc: '日常开发主力，性价比优先，多渠道互备', fallbackTo: ['B'], requireExplicit: false },
  B: { name: '免费消耗组', desc: '免费或极低成本，作为 A 组降级兜底', fallbackTo: [], requireExplicit: false },
  C: { name: '高配置组', desc: '昂贵/高配模型，严格控本，永不自动进入', fallbackTo: [], requireExplicit: true },
};

/**
 * @param {string} configPath
 * @param {object} [opts]
 *   opts.allowEmptyChannels 允许 channels 为空 —— 用于「渠道由 data/channels.json 接管」的场景：
 *   此时 YAML 只提供 server/groups/tokens/routes 等策略，渠道随后由 store 注入。
 */
function load(configPath, opts) {
  const options = opts || {};
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`找不到配置文件：${abs}\n请先复制 gateway.example.yaml 为 gateway.yaml 再修改。`);
  }

  const rawText = fs.readFileSync(abs, 'utf8');
  // .env 必须先加载：否则 gateway.yaml 里的 ${OPENCODE_GO_API_KEY} 会展开成空字符串，
  // 表现为「渠道配了但一律 401」，排查起来很费劲。
  loadDotEnv(path.dirname(abs));
  // 支持 ${ENV_VAR} 展开，方便把敏感 key 留在环境变量里
  const text = expandEnv(rawText);

  let doc;
  try {
    doc = yaml.parse(text);
  } catch (e) {
    throw new Error(`配置文件解析失败：${e.message}`);
  }

  // 原始未展开的文档：用于把 ${ENV_VAR} 原样写回渠道库，避免明文 Key 落盘
  let rawDoc = null;
  try {
    rawDoc = yaml.parse(rawText);
  } catch (_) {
    rawDoc = null;
  }

  const out = normalize(doc, path.dirname(abs), rawDoc, options);
  // 记住配置文件的绝对路径，供「重置回 YAML 基线」时重新加载
  out.__file = abs;
  return out;
}

/** 展开 ${VAR} 与 ${VAR:默认值} */
function expandEnv(text) {
  return String(text).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g, (m, name, dflt) => {
    const v = process.env[name];
    if (v != null && v !== '') return v;
    return dflt != null ? dflt : '';
  });
}

/**
 * 极简 .env 加载（零依赖）
 *
 * 规则刻意保守：
 *   - 只在变量「尚未存在」时写入 —— 真实环境变量优先级永远高于 .env，部署时不会被文件覆盖；
 *   - 不解析多行、不做变量嵌套替换，够用即可；
 *   - 支持 `KEY=value`、`export KEY=value`、行内注释之前的值、单双引号包裹。
 * 找不到文件就静默跳过（本地开发可以不建）。
 */
function loadDotEnv(dir) {
  const file = path.join(dir, '.env');
  if (!fs.existsSync(file)) return;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function normalize(doc, baseDir, rawDoc, opts) {
  const options = opts || {};
  const errors = [];

  const server = Object.assign(
    {
      host: '127.0.0.1',
      port: 8787,
      adminToken: '',
      requestTimeoutMs: 300000,
      connectTimeoutMs: 10000,
      maxRetries: 2,
      // 401/403/404 也重试：上游「这个渠道没有这个模型 / 这个渠道的 Key 失效」时，
      // 应当换下一个渠道再试，而不是把错误直接丢回给客户端 —— 这才是「模型不通就轮换」。
      retryOnStatus: [401, 403, 404, 408, 409, 429, 500, 502, 503, 504],
      // 单个请求体上限。默认 16MB：足够覆盖超长上下文，又不会让小内存机器
      // （1C2G）被几个并发大请求打爆。转发场景如确需更大，在 gateway.yaml 里显式调高。
      maxBodyBytes: 16 * 1024 * 1024,
      logLevel: 'info',
      dataDir: './data',
      logRequestBody: false,
    },
    doc.server || {}
  );

  // ---- 管理面登录（状态页 + 管理接口）----
  // 部署到公网时这是唯一挡在「谁都能改你的渠道和密钥」前面的东西，因此默认值偏保守：
  // 一旦 enabled，密码就不能为空，否则等于没开。
  const authSrc = (doc.server && doc.server.auth && typeof doc.server.auth === 'object') ? doc.server.auth : {};
  const auth = {
    enabled: authSrc.enabled === true,
    username: String(authSrc.username || 'admin').trim() || 'admin',
    password: String(authSrc.password != null ? authSrc.password : ''),
    sessionTtlSec: Number(authSrc.sessionTtlSec) > 0 ? Number(authSrc.sessionTtlSec) : 86400,
    // 走 https 反代时打开：只允许浏览器通过 HTTPS 回传会话 Cookie
    cookieSecure: authSrc.cookieSecure === true,
    // 防暴力破解：同一 IP 在窗口内连续失败达到上限就暂时拒绝
    maxFailures: Number(authSrc.maxFailures) > 0 ? Number(authSrc.maxFailures) : 8,
    failureWindowSec: Number(authSrc.failureWindowSec) > 0 ? Number(authSrc.failureWindowSec) : 600,
    // 是否采信 X-Forwarded-For。默认 false：直接暴露时信 XFF 等于把限速开关交给客户端。
    // 只有在 nginx / CDN 后面（真实 IP 被反代覆盖）时才设为 true。
    trustProxy: authSrc.trustProxy === true,
  };
  server.auth = auth;
  if (auth.enabled && !auth.password) {
    errors.push(
      'server.auth.enabled 为 true，但没有设置密码。\n' +
        '    请编辑 gateway.yaml 同目录下的 .env，把 GATEWAY_ADMIN_PASSWORD= 后面填上密码，\n' +
        '    或者在启动前设置同名环境变量。\n' +
        '    （没有密码的登录页等于没有登录页，所以这里直接拒绝启动）'
    );
  }

  const performance = Object.assign(
    {
      // 反向代理最关键的两项：不做任何缓冲、不重新压缩
      streamFlush: true,
      keepAlive: true,
      maxSocketsPerHost: 64,
      // 请求体超过该大小就不做 JSON 解析，直接透传（省 CPU）
      passthroughBodyBytes: 262144,
    },
    doc.performance || {}
  );

  // ---- 分组 ----
  const groups = {};
  const groupSrc = doc.groups && typeof doc.groups === 'object' ? doc.groups : {};
  for (const key of Object.keys(DEFAULT_GROUPS)) {
    const src = groupSrc[key] || {};
    groups[key] = Object.assign({ key }, DEFAULT_GROUPS[key], src, {
      budget: src.budget ? normalizeBudget(src.budget) : null,
      cache: Object.assign({ enabled: false, ttlSec: 3600, maxEntries: 1000, onlyDeterministic: true }, src.cache || {}),
      limits: Object.assign({ rpm: 0, tpm: 0, concurrency: 0 }, src.limits || {}),
    });
  }
  // 允许自定义额外分组
  for (const key of Object.keys(groupSrc)) {
    if (groups[key]) continue;
    const src = groupSrc[key] || {};
    groups[key] = Object.assign(
      { key, name: src.name || key, desc: src.desc || '', fallbackTo: [], requireExplicit: false },
      src,
      {
        budget: src.budget ? normalizeBudget(src.budget) : null,
        cache: Object.assign({ enabled: false, ttlSec: 3600, maxEntries: 1000, onlyDeterministic: true }, src.cache || {}),
        limits: Object.assign({ rpm: 0, tpm: 0, concurrency: 0 }, src.limits || {}),
      }
    );
  }

  // ---- 渠道 ----
  // 真源优先级：data/channels.json（页面管理）> gateway.yaml（手写基线）
  // 这里只负责把 YAML 里的这一段解析出来；若 store 存在，gateway.js 会用 store 的内容整体替换。
  const chSrc = Array.isArray(doc.channels) ? doc.channels : [];
  const rawChSrc = rawDoc && Array.isArray(rawDoc.channels) ? rawDoc.channels : [];
  const parsed = normalizeChannelList(chSrc, { server, groups, rawList: rawChSrc });
  const channels = parsed.channels;

  if (options.allowEmptyChannels) {
    // 渠道即将由 store 接管：YAML 里没有渠道是正常的，只提示、不报错
    if (parsed.errors.length) {
      console.warn('[config] YAML 渠道存在告警（若 data/channels.json 生效则会被整体覆盖）：\n  - ' + parsed.errors.join('\n  - '));
    }
  } else {
    for (const e of parsed.errors) errors.push(e);
  }

  // ---- 模型 → 组 的显式路由 ----
  const routes = {};
  const routeSrc = doc.routes && typeof doc.routes === 'object' ? doc.routes : {};
  for (const [model, g] of Object.entries(routeSrc)) {
    const list = Array.isArray(g) ? g.map((x) => String(x).toUpperCase()) : [String(g).toUpperCase()];
    for (const gk of list) {
      if (!groups[gk]) errors.push(`routes 中模型 ${model} 指向未定义的组 ${gk}`);
    }
    routes[model] = list;
  }

  // ---- 客户端令牌 ----
  const tokens = [];
  const tokSrc = Array.isArray(doc.tokens) ? doc.tokens : [];
  tokSrc.forEach((t, i) => {
    if (!t || typeof t !== 'object') {
      errors.push(`tokens[${i}] 不是对象`);
      return;
    }
    // 只接受「非空字符串」。这里刻意不用 if (!t.key) —— 那会把对象、数组之类
    // truthy 的脏值放过去，最终 String() 成 "[object Object]" 之类的可猜字符串，
    // 等于凭空造出一个能被猜到的令牌。宁可报错，也不要静默生效。
    const keyStr = typeof t.key === 'string' ? t.key.trim() : '';
    // enabled:false 的令牌允许先空着 —— 它本来就鉴权不过（server 里会挡），
    // 留作「以后开 B/C 组时再填」的模板，不逼用户一次性配齐所有密钥。
    const disabled = t.enabled === false;
    if (!keyStr && !disabled) {
      // 尽量把「到底是哪个变量没填」写进报错：展开前的原文档里还留着 ${VAR}
      const rawTok = rawDoc && Array.isArray(rawDoc.tokens) ? rawDoc.tokens[i] : null;
      const rawKey = rawTok && rawTok.key != null ? String(rawTok.key) : '';
      const ref = isEnvRef(rawKey) ? rawKey.trim() : null;
      errors.push(
        `tokens[${i}] 的 key 为空或类型不对（拿到的是 ${t.key === null ? 'null' : typeof t.key}）。\n` +
          (ref
            ? `    这里写的是 ${ref}，但环境里没有这个值 —— 请把该变量填进 gateway.yaml 同目录的 .env。\n`
            : '    若写成 ${ENV_VAR} 形式，多半是那个环境变量还没填 —— 检查 gateway.yaml 同目录下的 .env。\n') +
          '    放行一个空令牌等于没鉴权，所以这里直接拒绝启动。'
      );
      return;
    }
    tokens.push({
      key: keyStr,
      name: String(t.name || `token-${i}`),
      allowGroups: t.allowGroups ? t.allowGroups.map((x) => String(x).toUpperCase()) : Object.keys(groups),
      allowModels: Array.isArray(t.allowModels) ? t.allowModels.map(String) : [],
      denyModels: Array.isArray(t.denyModels) ? t.denyModels.map(String) : [],
      limits: Object.assign({ rpm: 0, tpm: 0, concurrency: 0, dailyUSD: 0, monthlyUSD: 0 }, t.limits || {}),
      enabled: t.enabled === false ? false : true,
    });
  });

  if (!options.allowEmptyChannels) {
    if (channels.length === 0) errors.push('没有配置任何渠道（channels 为空）');
    if (channels.filter((c) => c.enabled).length === 0) errors.push('所有渠道都是 enabled: false，网关无法工作');
  }

  // ---- 裸奔闸门 ----
  // 监听在非本机地址 = 打算对外提供服务。此时若既没有客户端令牌、又没开管理面登录，
  // 任何人扫到端口就能白嫖你的额度、还能进状态页看渠道配置。
  // 这种情况一律拒绝启动 —— 报错比事后发现被刷爆强。
  const bindHost = String(server.host || '127.0.0.1').trim();
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(bindHost);
  if (!isLoopback && tokens.length === 0 && !auth.enabled) {
    errors.push(
      `server.host 是 "${bindHost}"（对外提供服务），但既没有配置 tokens、也没有开启 server.auth。\n` +
        '    这会让任何能访问该端口的人都可直接调用你的模型额度。请至少做一件事：\n' +
        '      1) 配 server.auth（免登录界面的账号密码），或\n' +
        '      2) 配 tokens（调用方需带 Authorization: Bearer <key>）'
    );
  }

  // ---- 请求体上限校验 ----
  // 上限必须是正整数；过小会让正常长上下文请求直接 413，过大则失去保护意义。
  // 这里做区间钳制（1MB ~ 256MB），避免手滑写成 0 或负数导致「所有请求都 413」。
  const maxBodyBytes = Number(server.maxBodyBytes);
  if (!Number.isFinite(maxBodyBytes) || maxBodyBytes <= 0) {
    errors.push(`server.maxBodyBytes 必须是正整数，当前是 "${server.maxBodyBytes}"`);
  } else {
    // 上下都做钳制：下限 64KB（再小就是手滑，正常对话请求都会被打回），
    // 上限 256MB（再大对小内存机器没有意义）。
    server.maxBodyBytes = Math.min(256 * 1024 * 1024, Math.max(64 * 1024, Math.floor(maxBodyBytes)));
  }

  if (errors.length) {
    throw new Error('配置校验未通过：\n  - ' + errors.join('\n  - '));
  }

  const dataDir = path.resolve(baseDir, server.dataDir || './data');

  return {
    __path: path.resolve(baseDir),
    server: Object.assign({}, server, { dataDir }),
    performance,
    groups,
    channels,
    routes,
    tokens,
    pricing: doc.pricing || {},
    cache: Object.assign({ enabled: false, ttlSec: 600, maxEntries: 2000 }, doc.cache || {}),
    fallback: Object.assign(
      {
        enabled: true,
        // 默认降级顺序：A → B；C 永不自动进入
        chain: ['A', 'B'],
        crossGroup: true,
      },
      doc.fallback || {}
    ),
  };
}

function normalizeBudget(b) {
  return {
    dailyUSD: Number(b.dailyUSD) > 0 ? Number(b.dailyUSD) : 0,
    monthlyUSD: Number(b.monthlyUSD) > 0 ? Number(b.monthlyUSD) : 0,
    // 达到阈值时告警（0 表示不告警）
    warnRatio: Number(b.warnRatio) > 0 && Number(b.warnRatio) < 1 ? Number(b.warnRatio) : 0.8,
  };
}

// ---------------------------------------------------------------- 渠道归一化
//
// 这一段被两条路径复用：
//   1. 启动时解析 YAML 的 channels
//   2. 页面保存后归一化 store 里的 channels（热更新，不重启）
// 因此必须是纯函数：不读文件、不碰全局状态。

/**
 * @param {object} c        已展开 ${ENV} 的渠道对象
 * @param {number} i        下标（用于生成兜底 id 与报错定位）
 * @param {object} server   server 配置（提供 timeoutMs 默认值）
 * @param {object} [authored] 原始未展开的对象，用于保留 ${ENV_VAR} 引用
 * @returns {object|null}
 */
function normalizeChannel(c, i, server, authored) {
  if (!c || typeof c !== 'object') return null;
  const a = authored && typeof authored === 'object' ? authored : c;

  const id = String(c.id || `channel-${i + 1}`).trim();

  // apiKey 的处理是这里最讲究的一处：
  // 运行时必须是展开后的真实 Key，落盘时必须还原成 ${ENV_VAR}，
  // 否则页面每保存一次就把环境变量里的密钥固化成明文写进 channels.json。
  const authoredKey = a.apiKey != null ? String(a.apiKey) : '';
  const expandedKey = c.apiKey != null ? String(c.apiKey) : '';
  const keyRef = isEnvRef(authoredKey) ? authoredKey.trim() : null;
  const apiKey = keyRef ? expandEnv(keyRef) : expandedKey;

  const lim = normalizeLimits(c.limits);
  const timeoutMs = Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) : Number(server.requestTimeoutMs) || 300000;

  return {
    id,
    name: String(c.name || id),
    group: String(c.group || 'A').trim().toUpperCase(),
    provider: String(c.provider || 'openai').trim().toLowerCase(),
    plan: String(c.plan || 'standard').trim(),
    baseUrl: String(c.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey,
    /** 若原始值是 ${ENV_VAR}，这里保留引用，供落盘使用 */
    keyRef,
    headers: c.headers && typeof c.headers === 'object' ? Object.assign({}, c.headers) : {},
    models: normalizeStringList(c.models),
    modelMap: c.modelMap && typeof c.modelMap === 'object' ? Object.assign({}, c.modelMap) : {},
    weight: positive(c.weight, 100),
    priority: positive(c.priority, 100),
    /** 组内消耗顺序（0 起）。页面里从上往下就是这个顺序；未设置时由下面的按组重编号补齐 */
    order: intOrUndefined(c.order),
    enabled: c.enabled !== false,
    limits: lim,
    timeoutMs,
    cooldown: Object.assign({ baseSec: 60, maxSec: 900, failThreshold: 3 }, c.cooldown || {}),
  };
}

/**
 * 批量归一化 + 校验
 * @returns {{channels: object[], errors: string[]}}
 */
function normalizeChannelList(list, o) {
  const opts = o || {};
  const server = opts.server || {};
  const groups = opts.groups || {};
  const rawList = Array.isArray(opts.rawList) ? opts.rawList : [];
  const channels = [];
  const errors = [];
  const seen = new Set();

  if (!Array.isArray(list)) return { channels, errors };

  list.forEach((c, i) => {
    const ch = normalizeChannel(c, i, server, rawList[i]);
    if (!ch) {
      errors.push(`channels[${i}] 不是对象`);
      return;
    }
    if (!ch.id) {
      errors.push(`channels[${i}] 缺少 id`);
      return;
    }
    if (seen.has(ch.id)) {
      errors.push(`渠道 id 重复：${ch.id}`);
      return;
    }
    seen.add(ch.id);
    if (!ch.baseUrl) errors.push(`渠道 ${ch.id} 缺少 baseUrl`);
    else if (!/^https?:\/\//i.test(ch.baseUrl)) errors.push(`渠道 ${ch.id} 的 baseUrl 必须以 http:// 或 https:// 开头`);
    else {
      try {
        // eslint-disable-next-line no-new
        new URL(ch.baseUrl);
      } catch (_) {
        errors.push(`渠道 ${ch.id} 的 baseUrl 不是合法 URL：${ch.baseUrl}`);
      }
    }
    if (groups && Object.keys(groups).length && !groups[ch.group]) {
      errors.push(`渠道 ${ch.id} 的 group "${ch.group}" 未定义`);
    }
    channels.push(ch);
  });

  // 组内顺序重编号：把每组压成 0..n-1 的稠密序号。
  // 有显式 order 的按它排；没写的排在该组最后（保持文件里的先后），
  // 这样「新加的渠道默认排在末尾」，不会莫名其妙插到队首抢走流量。
  const byGroup = new Map();
  for (const ch of channels) {
    if (!byGroup.has(ch.group)) byGroup.set(ch.group, []);
    byGroup.get(ch.group).push(ch);
  }
  for (const groupChannels of byGroup.values()) {
    groupChannels
      .map((ch, idx) => ({ ch, idx }))
      .sort((x, y) => {
        const xo = Number.isFinite(x.ch.order) ? x.ch.order : Number.MAX_SAFE_INTEGER;
        const yo = Number.isFinite(y.ch.order) ? y.ch.order : Number.MAX_SAFE_INTEGER;
        if (xo !== yo) return xo - yo;
        return x.idx - y.idx;
      })
      .forEach((it, idx) => { it.ch.order = idx; });
  }

  return { channels, errors };
}

/** 让页面保存的渠道能直接替换运行时渠道（校验通过才替换） */
function validateChannelList(list, config) {
  return normalizeChannelList(list, {
    server: config.server,
    groups: config.groups,
    rawList: list, // store 里的对象本身就是「原始形态」，无需再拆分展开/未展开
  });
}

function normalizeLimits(lim) {
  const l = lim && typeof lim === 'object' ? lim : {};
  return {
    rpm: nonNeg(l.rpm),
    tpm: nonNeg(l.tpm),
    concurrency: nonNeg(l.concurrency),
    // 配额窗口：coding plan / agent plan 的「N 小时 M 次」
    windowSec: nonNeg(l.windowSec),
    windowMaxRequests: nonNeg(l.windowMaxRequests),
    windowMaxTokens: nonNeg(l.windowMaxTokens),
  };
}

/** 兼容数组与 "a, b c" / 换行分隔的字符串 */
function normalizeStringList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') {
    return v
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

function positive(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** 可缺省的整数：填了就给整数，没填/填错给 undefined（交给按组重编号兜底） */
function intOrUndefined(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function nonNeg(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

module.exports = { load, normalize, normalizeChannel, normalizeChannelList, validateChannelList };
