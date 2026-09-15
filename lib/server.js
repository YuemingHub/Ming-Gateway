'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Pricer } = require('./pricing');
const { Limiter } = require('./limiter');
const { HealthRegistry } = require('./health');
const { Router } = require('./router');
const { Usage } = require('./usage');
const { ResponseCache } = require('./cache');
const { forward, authHeaders } = require('./proxy');
const { validateChannelList } = require('./config');
const { Auth, clientIp } = require('./auth');
const { ChannelStore, toStored, maskKey, isEnvRef } = require('./store');

const VERSION = '1.0.0';
/** 未配置 server.maxBodyBytes 时的兜底值（16MB） */
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * 探测超时（都不是关键路径，只在管理接口用）。
 * 刻意压得比较短：连接不上时快速给结论，比「转圈 35 秒然后说超时」有用得多。
 */
const MODELS_PROBE_MS = 10000;
const CHAT_PROBE_MS = 15000;

/** 页面「添加渠道」的快捷模板 */
const PROVIDERS = [
  { key: 'openai', label: 'OpenAI 兼容协议', hint: '绝大多数国内外厂商（DeepSeek/智谱/通义/Kimi/豆包/硅基流动/Ollama…）都用这一种' },
  { key: 'anthropic', label: 'Anthropic 原生', hint: '请求头用 x-api-key + anthropic-version' },
  { key: 'gemini', label: 'Google Gemini', hint: '用 x-goog-api-key，建议走 /v1beta/openai 兼容入口' },
  { key: 'cohere', label: 'Cohere', hint: 'Bearer 鉴权' },
];

const PLANS = [
  { key: 'standard', label: '标准按量', hint: '按 token 计费' },
  { key: 'coding', label: 'Coding 套餐', hint: '订阅制，通常带「N 小时 M 次」窗口，可在限流里配 windowSec' },
  { key: 'agent', label: 'Agent 套餐', hint: '订阅制，同上' },
  { key: 'free', label: '免费 / 极低成本', hint: '适合放 B 组兜底' },
];

const PRESETS = [
  {
    key: 'preset-deepseek', label: 'DeepSeek', provider: 'openai', group: 'A', plan: 'standard',
    baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], envVar: 'DEEPSEEK_API_KEY',
  },
  {
    key: 'preset-glm', label: '智谱 GLM', provider: 'openai', group: 'A', plan: 'standard',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4-flash'], envVar: 'GLM_API_KEY',
  },
  {
    key: 'preset-glm-coding', label: '智谱 GLM Coding Plan', provider: 'openai', group: 'A', plan: 'coding',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', models: ['glm-4.6', 'glm-4.5'], envVar: 'GLM_CODING_API_KEY',
    limits: { concurrency: 2, windowSec: 18000, windowMaxRequests: 400 },
  },
  {
    key: 'preset-qwen', label: '通义千问', provider: 'openai', group: 'A', plan: 'standard',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo'], envVar: 'QWEN_API_KEY',
  },
  {
    key: 'preset-doubao', label: '字节豆包', provider: 'openai', group: 'A', plan: 'standard',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-pro-32k', 'doubao-lite-32k'], envVar: 'DOUBAO_API_KEY',
  },
  {
    key: 'preset-kimi', label: '月之暗面 Kimi', provider: 'openai', group: 'A', plan: 'standard',
    baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-32k', 'kimi-k2'], envVar: 'KIMI_API_KEY',
  },
  {
    key: 'preset-siliconflow', label: '硅基流动（免费额度）', provider: 'openai', group: 'B', plan: 'free',
    baseUrl: 'https://api.siliconflow.cn/v1', models: ['Qwen/Qwen2.5-7B-Instruct', 'THUDM/glm-4-9b-chat'], envVar: 'SILICONFLOW_API_KEY',
    limits: { rpm: 60 },
  },
  {
    key: 'preset-ollama', label: '本地 Ollama', provider: 'openai', group: 'B', plan: 'free',
    baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen2.5:7b', 'deepseek-r1:7b'], envVar: '',
    limits: { concurrency: 2 },
  },
  {
    key: 'preset-openrouter', label: 'OpenRouter', provider: 'openai', group: 'C', plan: 'standard',
    baseUrl: 'https://openrouter.ai/api/v1', models: [], envVar: 'OPENROUTER_API_KEY',
  },
  {
    key: 'preset-openai', label: 'OpenAI 官方', provider: 'openai', group: 'C', plan: 'standard',
    baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4.1', 'o3-mini'], envVar: 'OPENAI_API_KEY',
  },
  {
    key: 'preset-anthropic', label: 'Anthropic 官方', provider: 'anthropic', group: 'C', plan: 'standard',
    baseUrl: 'https://api.anthropic.com/v1', models: ['claude-sonnet-4-5', 'claude-opus-4-1'], envVar: 'ANTHROPIC_API_KEY',
  },
  {
    key: 'preset-gemini', label: 'Google Gemini', provider: 'gemini', group: 'C', plan: 'standard',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.5-pro', 'gemini-2.5-flash'], envVar: 'GEMINI_API_KEY',
  },
];

/** 可被页面写入的渠道字段白名单 */
const EDITABLE_FIELDS = [
  'id', 'name', 'group', 'provider', 'plan', 'baseUrl',
  'models', 'modelMap', 'headers', 'weight', 'priority',
  'enabled', 'limits', 'timeoutMs', 'cooldown',
];


class GatewayServer {
  constructor(config) {
    this.config = config;
    this.configPath = config.__file || null;
    this.store = new ChannelStore(config.server.dataDir);
    this.pricer = new Pricer(config.pricing);
    this.limiter = new Limiter();
    this.health = new HealthRegistry(config.channels);
    this.router = new Router(config, this.health, this.limiter);
    this.usage = new Usage(config.server.dataDir);
    this.cache = new ResponseCache(config.cache);
    this.startedAt = new Date();

    this.requireAuth = config.tokens.length > 0;
    this.tokenMap = new Map(config.tokens.map((t) => [t.key, t]));

    // 请求体上限：config 已做过区间钳制，这里再兜一层防止直接 new Gateway 绕过校验
    const cfgMax = Number(config.server && config.server.maxBodyBytes);
    this.maxBodyBytes = Number.isFinite(cfgMax) && cfgMax > 0 ? cfgMax : DEFAULT_MAX_BODY_BYTES;

    // 是否采信 X-Forwarded-For（仅当确实部署在反代后面才为 true）
    this.trustProxy = !!(config.server && config.server.auth && config.server.auth.trustProxy);

    // 管理面登录（状态页 + /__gw/api/*）
    this.auth = new Auth(config.server.auth, (lv, m) => this.log(lv, m));
    this._authSweep = setInterval(() => this.auth.sweep(), 5 * 60 * 1000);
    if (this._authSweep.unref) this._authSweep.unref();

    this._reqSeq = 0;
    this.usage.start();
  }

  start() {
    const { host, port } = this.config.server;
    this.server = http.createServer((req, res) => this.handle(req, res));
    // 长连接复用，减少 TLS/握手开销
    this.server.keepAliveTimeout = 65000;
    this.server.headersTimeout = 70000;
    this.server.requestTimeout = 0; // 由我们自己按渠道 timeoutMs 控制
    return new Promise((resolve) => {
      this.server.listen(port, host, () => resolve(this.server.address()));
    });
  }

  stop() {
    this.usage.stop();
    if (this._authSweep) clearInterval(this._authSweep);
    if (this.server) this.server.close();
  }

  // ------------------------------------------------- 渠道管理（热更新，不重启）

  /**
   * 把新的渠道列表切换为运行时生效
   *
   * 注意这里替换的是 this.config.channels 这个数组引用：
   * Router 持有的是 config 对象本身，每次 candidates() 都实时读 config.channels，
   * 所以只要换掉引用，后续请求立即走新渠道 —— 无需重启进程。
   */
  applyChannels(list) {
    this.config.channels = list;
    this.health.sync(list);
    for (const c of list) {
      const h = this.health.get(c.id);
      if (h) h.groupKey = c.group;
    }
    this.router.byId = new Map(list.map((c) => [c.id, c]));
    return list.length;
  }

  /** 当前生效的渠道 → 可落盘形态（apiKey 保留 ${ENV_VAR} 引用） */
  storedChannels() {
    return this.config.channels.map(toStored);
  }

  /** 回传给页面的渠道视图：密钥一律掩码，绝不下发明文 */
  channelView(c) {
    const h = this.health.get(c.id);
    const now = Date.now();
    return {
      id: c.id,
      name: c.name,
      group: c.group,
      provider: c.provider,
      plan: c.plan,
      baseUrl: c.baseUrl,
      models: c.models,
      modelMap: c.modelMap,
      headers: c.headers,
      weight: c.weight,
      priority: c.priority,
      enabled: h ? h.enabled : c.enabled !== false,
      limits: c.limits,
      timeoutMs: c.timeoutMs,
      cooldown: c.cooldown,
      // 密钥相关：只给「有没有」和掩码，够你确认配置状态，又不会泄露
      hasApiKey: !!c.apiKey,
      apiKeyMasked: maskKey(c.keyRef || c.apiKey),
      keyFromEnv: isEnvRef(c.keyRef || ''),
      // 运行时状态（表格里直接显示，省得再去对照状态页）
      healthy: h ? h.isAvailable(now) : false,
      cooldownRemainSec: h ? h.cooldownRemainSec : 0,
      lastError: h ? h.lastError : null,
      inflight: this.limiter.snapshot('channel:' + c.id, c.limits).inflight,
      stats: h ? h.snapshot() : null,
    };
  }

  channelsPayload() {
    const info = this.store.info();
    return {
      ok: true,
      source: info.source,
      file: info.file,
      updatedAt: info.updatedAt,
      canReset: info.source === 'store',
      groups: Object.entries(this.config.groups).map(([k, g]) => ({
        key: k,
        name: g.name,
        desc: g.desc,
        requireExplicit: !!g.requireExplicit,
        fallbackTo: g.fallbackTo || [],
        budget: g.budget || null,
        count: this.config.channels.filter((c) => c.group === k).length,
      })),
      channels: this.config.channels.map((c) => this.channelView(c)),
    };
  }

  /**
   * 客户端令牌（调用本网关用的 API KEY）。
   *
   * 和 channelView 里「渠道密钥只给掩码」不同：这里的令牌本来就是给运营者本人
   * 复制进调用方的，页面拿不到明文就等于没这个功能。所以：
   *   - 只挂在管理面（handleAdmin）下，走与渠道增删改同一道鉴权闸门；
   *   - 响应带 cache-control: no-store，别在浏览器/中间层留副本；
   *   - 页面默认打码，点「显示」才展开，避免截图或旁人一眼看全。
   */
  tokensPayload() {
    return {
      ok: true,
      authEnabled: this.auth.enabled,
      tokens: (this.config.tokens || []).map((t, i) => ({
        index: i,
        name: t.name,
        groups: t.allowGroups || [],
        enabled: t.enabled !== false,
        key: t.key,
        keyMasked: maskKey(t.key),
      })),
    };
  }

  /**
   * 校验 → 落盘 → 热更新。三步全成功才算保存成功，
   * 任一步失败都保持原渠道不变（页面拿到明确错误，不会出现「存了个跑不起来的渠道」）。
   */
  persistChannels(list, extra) {
    const v = validateChannelList(list, this.config);
    if (v.errors.length) {
      return { ok: false, errors: v.errors };
    }
    if (v.channels.length === 0) {
      return { ok: false, errors: ['至少需要保留一个渠道，否则网关无法转发任何请求'] };
    }
    const stored = v.channels.map(toStored);
    try {
      this.store.write(stored, extra);
    } catch (e) {
      return { ok: false, errors: ['写入渠道库失败：' + e.message] };
    }
    this.applyChannels(v.channels);
    return { ok: true, channels: v.channels };
  }

  // ---------------------------------------------------------------- 入口

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    // CORS 预检
    if (req.method === 'OPTIONS') {
      return sendJson(res, 204, {}, corsHeaders(req));
    }

    // 登录 / 登出必须在鉴权闸门之前，否则自己都进不去
    if (pathname === '/__gw/login') return this.handleLogin(req, res, url);
    if (pathname === '/__gw/logout') return this.handleLogout(req, res);

    // ---- 管理面 ----
    const isDashboard = pathname === '/' || pathname === '/__gw' || pathname === '/__gw/' || pathname === '/__gw/dashboard';
    const isAdminApi = pathname.startsWith('/__gw/');
    if (isDashboard || isAdminApi) {
      if (!this.adminAllowed(req, res, isDashboard)) return;
      return isDashboard ? this.serveDashboard(req, res) : this.handleAdmin(req, res, pathname, url);
    }

    // ---- 数据面 ----
    if (pathname === '/healthz') return sendJson(res, 200, { ok: true, version: VERSION });

    return this.handleProxy(req, res, pathname, url);
  }

  // ---------------------------------------------------------------- 管理面鉴权

  /** 本机直连判断（含 IPv4-mapped IPv6） */
  isLocalRequest(req) {
    // 开了 trustProxy 就以 X-Forwarded-For 为准：反代后面 socket 地址永远是 127.0.0.1，
    // 只看 socket 会把「本机放行」这条规则放大成「任何人放行」。
    const remote = String(clientIp(req, this.trustProxy) || '').replace('::ffff:', '');
    return remote === '127.0.0.1' || remote === '::1' || remote === 'localhost';
  }

  /** 请求头里带的管理令牌是否正确 */
  adminTokenOk(req) {
    const cfg = this.config.server.adminToken;
    if (!cfg) return false;
    const raw = req.headers['x-admin-token'] || String(req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const provided = Array.isArray(raw) ? String(raw[0] || '') : String(raw || '');
    return safeEqual(provided, String(cfg));
  }

  /**
   * 管理面闸门。放行条件（任一）：
   *   1) 配置了 adminToken 且请求带对了 —— 给脚本 / 运维用
   *   2) 未配置 adminToken 且来源是本机 —— 保持「本机开箱即用」的体验
   *   3) 开启了 server.auth 且已有有效登录会话 —— 部署到公网后的正常路径
   *
   * 未通过：浏览器 GET 请求跳登录页；接口请求返回 401 JSON。
   * @returns {boolean} true = 放行
   */
  adminAllowed(req, res, isDashboard) {
    if (this.config.server.adminToken) {
      if (this.adminTokenOk(req)) return true;
      return this.denyAdmin(req, res, isDashboard, 'admin token 无效');
    }
    if (!this.auth.enabled && this.isLocalRequest(req)) return true;
    if (this.auth.enabled && this.auth.isLoggedIn(req)) return true;
    return this.denyAdmin(
      req,
      res,
      isDashboard,
      this.auth.enabled ? '未登录或登录已过期，请重新登录' : '未配置 adminToken 时管理接口仅允许本机访问'
    );
  }

  denyAdmin(req, res, isDashboard, msg) {
    const wantsHtml = isDashboard || String(req.headers.accept || '').includes('text/html');
    if (wantsHtml && req.method === 'GET') {
      const next = encodeURIComponent(req.url || '/__gw/');
      res.writeHead(302, { location: '/__gw/login?next=' + next, 'cache-control': 'no-store' });
      res.end();
      return false;
    }
    sendJson(res, 401, { ok: false, error: msg, needLogin: true });
    return false;
  }

  handleLogin(req, res, url) {
    // 没开登录功能时，这个地址不存在意义 —— 直接回状态页，别给一个摆设表单
    if (!this.auth.enabled) {
      res.writeHead(302, { location: '/__gw/', 'cache-control': 'no-store' });
      return res.end();
    }

    const rawNext = url.searchParams.get('next') || '';
    const next = safeNextPath(rawNext);

    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(this.auth.page({ next }));
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '需要 GET 或 POST' });

    const ip = clientIp(req, this.trustProxy);
    const blocked = this.auth.blockedFor(ip);
    if (blocked > 0) {
      res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(this.auth.page({ error: `失败次数过多，请 ${blocked} 秒后再试`, next }));
    }

    readBody(req, 64 * 1024)
      .then((buf) => {
        const form = new URLSearchParams(buf.toString('utf8'));
        const username = form.get('username') || '';
        const password = form.get('password') || '';
        const target = safeNextPath(form.get('next') || next);
        // 用户名来自不可信输入，落地日志前先压成一行，避免伪造换行注入日志
        const safeUser = oneLine(username, 64);

        if (!this.auth.verify(username, password)) {
          this.auth.noteFailure(ip);
          this.log('warn', `登录失败：user="${safeUser}" ip=${ip}`);
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(this.auth.page({ error: '用户名或密码不正确', next: target }));
        }

        this.auth.clearFailures(ip);
        this.auth.issue(req, res, username);
        this.log('info', `登录成功：user="${safeUser}" ip=${ip}`);
        res.writeHead(302, { location: target, 'cache-control': 'no-store' });
        res.end();
      })
      .catch((e) => {
        // 没有 catch 的话，请求体超限会让 Promise 无人接，Node 直接终止进程
        this.log('warn', `登录请求处理失败：${(e && e.message) || e}`);
        if (res.writableEnded) return;
        const status = e && e.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
        res.writeHead(status, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'close',
        });
        res.end(this.auth.page({ error: '请求无法处理，请重试', next }));
      });
  }

  handleLogout(req, res) {
    const s = this.auth.session(req);
    if (s) this.log('info', `退出登录：user="${s.user}"`);
    this.auth.revoke(req, res);
    res.writeHead(302, { location: '/__gw/login', 'cache-control': 'no-store' });
    res.end();
  }

  // ---------------------------------------------------------------- 数据面

  async handleProxy(req, res, pathname, url) {
    const t0 = Date.now();
    const requestId = 'req_' + (++this._reqSeq).toString(36) + Date.now().toString(36).slice(-4);
    let clientToken = null;

    try {
      // 1. 鉴权
      clientToken = this.authenticate(req);
      if (this.requireAuth && !clientToken) {
        return sendJson(res, 401, this.errBody('未提供有效的 API Key', 'auth_error'), corsHeaders(req));
      }

      // 2. 读请求体（上限由 server.maxBodyBytes 控制，默认 16MB）
      let bodyBuf = null;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        bodyBuf = await readBody(req, this.maxBodyBytes);
      }

      // 3. 提取 model（不整体解析 JSON，只做正则快速定位）
      let parsed = null;
      let model = '';
      if (bodyBuf && bodyBuf.length) {
        parsed = tryParseJson(bodyBuf);
        model = (parsed && parsed.model) || extractModelFast(bodyBuf) || '';
      }

      // 4. GET /v1/models
      if (pathname === '/v1/models' || pathname === '/models') {
        return sendJson(res, 200, this.modelsPayload(clientToken), corsHeaders(req));
      }

      if (!model) {
        // Anthropic 原生格式没有 model 在外层的情况由 body 解析兜底；仍为空则报错
        return sendJson(res, 400, this.errBody('请求体缺少 model 字段', 'invalid_request'), corsHeaders(req));
      }

      // 5. 解析显式分组：header X-GW-Group 或 model 前缀 "c:gpt-4o"
      let explicitGroup = req.headers['x-gw-group'] ? String(req.headers['x-gw-group']) : null;
      let upstreamModelName = model;
      const m = /^([abc]):(.+)$/i.exec(model);
      if (m) {
        explicitGroup = m[1].toUpperCase();
        upstreamModelName = m[2];
        model = m[2];
        // 需要改写 body 里的 model
        if (parsed) {
          parsed.model = upstreamModelName;
          bodyBuf = Buffer.from(JSON.stringify(parsed));
        }
      }

      // 6. 授权：令牌允许的组/模型
      const allowGroups = clientToken ? clientToken.allowGroups : null;
      if (clientToken) {
        if (clientToken.denyModels.includes(model)) {
          return sendJson(res, 403, this.errBody(`令牌 ${clientToken.name} 禁止访问模型 ${model}`, 'forbidden'), corsHeaders(req));
        }
        if (clientToken.allowModels.length && !clientToken.allowModels.includes(model)) {
          return sendJson(res, 403, this.errBody(`令牌 ${clientToken.name} 未授权模型 ${model}`, 'forbidden'), corsHeaders(req));
        }
      }

      const groupKeys = this.router.resolveGroups(model, explicitGroup, allowGroups);
      if (!groupKeys.length) {
        return sendJson(
          res,
          403,
          this.errBody(`模型 ${model} 没有可用的分组（C 组需显式指定）`, 'no_available_group'),
          corsHeaders(req)
        );
      }

      // 7. 预算熔断（C 组等配置了 budget 的组）
      for (const gk of groupKeys) {
        const trip = this.checkBudget(gk);
        if (trip.tripped) {
          return sendJson(res, 429, this.errBody(trip.reason, 'budget_exceeded'), corsHeaders(req));
        }
      }

      // 8. 估算 token（用于限流预扣，按 4 字符 ≈ 1 token 粗估）
      const estTokens = Math.max(1, Math.ceil((bodyBuf ? bodyBuf.length : 0) / 4));

      // 9. 缓存（仅非流式确定性请求）
      const stream = !!(parsed && parsed.stream);
      let cacheKey = null;
      let cacheGroupTtl = 0;
      if (!stream && parsed && this.cache.shouldCache(parsed)) {
        const g0 = this.config.groups[groupKeys[0]];
        if (g0 && g0.cache && g0.cache.enabled) {
          cacheKey = (g0.key || groupKeys[0]) + ':' + this.cache.key(model, parsed);
          cacheGroupTtl = g0.cache.ttlSec;
          const hit = this.cache.get(cacheKey);
          if (hit) {
            const latencyMs = Date.now() - t0;
            this.record({
              requestId, model, requestedModel: model, group: groupKeys[0],
              channelId: '-', channelName: 'cache', status: 200, ok: true,
              latencyMs, stream: false, promptTokens: hit.usage ? hit.usage.promptTokens : 0,
              completionTokens: hit.usage ? hit.usage.completionTokens : 0,
              costUSD: 0, cacheHit: true, attempts: 0, error: null,
              clientKey: clientToken ? clientToken.name : '-',
            });
            res.writeHead(200, Object.assign({ 'content-type': 'application/json', 'X-GW-Cache': 'HIT', 'X-GW-Request-Id': requestId }, corsHeaders(req)));
            return res.end(Buffer.from(hit.text, 'utf8'));
          }
        }
      }

      // 10. 选渠道并逐个尝试
      const candidates = this.router.candidates(groupKeys, model, estTokens, clientToken ? clientToken.name : null, true);
      if (!candidates.length) {
        return sendJson(
          res,
          503,
          this.errBody(`所有可用渠道均不可用（冷却中或触发限流）：组 ${groupKeys.join(',')}`, 'no_available_channel'),
          corsHeaders(req)
        );
      }

      const maxAttempts = Math.min(candidates.length, Math.max(1, this.config.server.maxRetries + 1));
      const retryOn = new Set(this.config.server.retryOnStatus);
      let lastErr = null;
      let lastStatus = 502;
      let streamStarted = false; // 流式已吐出字节后禁止重试（响应头已发出，无法回退）

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const cand = candidates[attempt];
        const channel = cand.channel;
        const h = this.health.get(channel.id);
        const ck = 'channel:' + channel.id;

        // 构造上游请求
        let sendBody = bodyBuf;
        const upModel = this.router.upstreamModel(channel, model);
        const needRewrite =
          upModel !== model ||
          (stream && this.config.server.injectStreamUsage !== false);

        if (needRewrite && parsed) {
          const copy = Object.assign({}, parsed);
          copy.model = upModel;
          if (stream && this.config.server.injectStreamUsage !== false && !copy.stream_options) {
            copy.stream_options = { include_usage: true };
          }
          sendBody = Buffer.from(JSON.stringify(copy));
        }

        const upstreamPath = pathname.replace(/^\/+/, '');
        const target = this.router.buildUrl(channel, upstreamPath);

        // 清洗请求头：逐跳首部不能透传，否则上游会判请求畸形
        const fwdHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const lk = k.toLowerCase();
          if (lk === 'host' || lk === 'content-length' || lk === 'connection' || lk === 'transfer-encoding' || lk === 'expect') continue;
          if (lk.startsWith('x-gw-')) continue;
          fwdHeaders[k] = v;
        }

        this.limiter.acquire(ck, channel.limits, estTokens);
        // 并发槽必须且只能归还一次。
        // forward 正常返回时（无论成功还是 4xx/5xx）下面的 release() 已经归还；
        // 这里加一道闸门，是为了防止「release() 之后的后续处理抛异常」时
        // catch 分支再归还一次 —— 那会把别人的在飞槽位也还掉，
        // 让并发计数失真、并发上限形同虚设。
        let slotReleased = false;
        const releaseSlot = () => {
          if (slotReleased) return;
          slotReleased = true;
          this.limiter.releaseConcurrency(ck);
        };
        const startedAt = Date.now();

        try {
          streamStarted = false;
          const r = await forward({
            channel,
            url: target,
            method: req.method,
            headers: fwdHeaders,
            body: sendBody,
            res,
            timeoutMs: channel.timeoutMs,
            stream,
            onFirstByte: () => {
              streamStarted = true;
            },
          });

          const latencyMs = Date.now() - startedAt;
          const usageRaw = r.usage || {};
          const cost = this.pricer.cost(upModel, usageRaw);
          const realTokens = (usageRaw.promptTokens || 0) + (usageRaw.completionTokens || 0);
          // 成功与失败都走这里：预扣的 token 按实际用量校正，并发槽一并归还。
          // 必须在 ok 判断之前 —— 上游报错时槽位同样要还，否则渠道会被占死。
          this.limiter.release(ck, channel.limits, estTokens, realTokens);
          slotReleased = true;

          const ok = r.status >= 200 && r.status < 300;

          if (ok) {
            h.markSuccess(latencyMs, {
              promptTokens: usageRaw.promptTokens || 0,
              completionTokens: usageRaw.completionTokens || 0,
              costUSD: cost.costUSD,
            });

            // 非流式响应在这里统一写回（流式已在 forward 里边收边写）
            if (!stream && res && !res.writableEnded) {
              const outHeaders = Object.assign({}, r.headers, corsHeaders(req), {
                'X-GW-Channel': channel.id,
                'X-GW-Request-Id': requestId,
                'X-GW-Latency': String(latencyMs),
              });
              res.writeHead(r.status, outHeaders);
              res.end(r.body);
            }
            this.record({
              requestId, model: upModel, requestedModel: model, group: cand.group,
              channelId: channel.id, channelName: channel.name, status: r.status, ok: true,
              latencyMs, stream, promptTokens: usageRaw.promptTokens || 0,
              completionTokens: usageRaw.completionTokens || 0, costUSD: cost.costUSD,
              cacheHit: false, attempts: attempt + 1, error: null,
              clientKey: clientToken ? clientToken.name : '-',
            });
            if (clientToken) this.usage.addTokenCost(clientToken.name, cost.costUSD);

            // 写回缓存
            if (cacheKey && r.text && r.status === 200) {
              this.cache.set(cacheKey, { text: r.text, usage: usageRaw }, cacheGroupTtl);
            }
            this.log('info', `${requestId} ${model} → ${channel.id} ${r.status} ${latencyMs}ms`);
            return; // 响应已在 forward 内写回
          }

          // 上游返回错误
          lastStatus = r.status;
          lastErr = `上游返回 ${r.status}: ${(r.text || '').slice(0, 300)}`;
          h.markFailure(lastErr);

          this.record({
            requestId, model: upModel, requestedModel: model, group: cand.group,
            channelId: channel.id, channelName: channel.name, status: r.status, ok: false,
            latencyMs, stream, promptTokens: 0, completionTokens: 0, costUSD: 0,
            cacheHit: false, attempts: attempt + 1, error: lastErr,
            clientKey: clientToken ? clientToken.name : '-',
          });

          if (r.streamed || streamStarted) {
            // 已经开始向客户端输出，无法回退，只能就此结束
            this.log('warn', `${requestId} ${channel.id} 流式传输中途失败，无法重试`);
            return;
          }

          if (!retryOn.has(r.status) || attempt === maxAttempts - 1) {
            // 不再重试：把上游错误体原样返回给客户端（保持原有 API 行为一致）
            writeRaw(
              res,
              r.status,
              Object.assign({ 'content-type': 'application/json', 'X-GW-Channel': channel.id, 'X-GW-Request-Id': requestId }, corsHeaders(req)),
              r.body || Buffer.from(JSON.stringify(this.errBody(lastErr, 'upstream_error')))
            );
            return;
          }
          this.log('warn', `${requestId} ${channel.id} 失败(${r.status})，切换下一个渠道`);
        } catch (err) {
          const latencyMs = Date.now() - startedAt;
          releaseSlot();
          // 客户端是不是真的已经走了？
          // 不能只凭 err.code 判断：我们自己按超时掐断上游时，socket 关闭同样会带
          // ECONNRESET，但那时客户端还在线 —— 若误判成「客户端断开」直接 return，
          // 客户端就永远等不到响应，只能挂到自己的超时。
          const clientGone = !res || res.destroyed || res.writableEnded;
          const clientAbort = clientGone || (err && err.code === 'ECONNRESET');
          h.markFailure(err && err.message, { noCount: clientAbort });
          lastErr = String((err && err.message) || err);
          this.record({
            requestId, model: upModel, requestedModel: model, group: cand.group,
            channelId: channel.id, channelName: channel.name, status: 0, ok: false,
            latencyMs, stream, promptTokens: 0, completionTokens: 0, costUSD: 0,
            cacheHit: false, attempts: attempt + 1, error: lastErr,
            clientKey: clientToken ? clientToken.name : '-',
          });
          this.log('warn', `${requestId} ${channel.id} 异常：${lastErr}`);

          if (clientAbort || streamStarted) return; // 客户端断开 / 流式已输出，都不再重试

          if (attempt === maxAttempts - 1) {
            writeRaw(
              res,
              502,
              Object.assign({ 'content-type': 'application/json', 'X-GW-Request-Id': requestId }, corsHeaders(req)),
              Buffer.from(JSON.stringify(this.errBody('全部渠道尝试失败：' + lastErr, 'all_channels_failed')))
            );
            return;
          }
        }
      }
    } catch (err) {
      // 请求体超限是客户端的错，不该记成 500，也不该把堆栈打进 error 日志
      if (err && err.code === 'PAYLOAD_TOO_LARGE') {
        this.log('warn', `${requestId} 请求体超过上限 ${err.limit} 字节，已拒绝`);
        sendTooLarge(res, err.limit, corsHeaders(req));
        return;
      }
      this.log('error', `${requestId} 处理异常：${err && err.stack}`);
      if (!res.writableEnded) {
        sendJson(res, 500, this.errBody(String((err && err.message) || err), 'internal_error'), corsHeaders(req));
      }
    }
  }

  // ---------------------------------------------------------------- 辅助

  authenticate(req) {
    if (!this.requireAuth) return null;
    const auth = req.headers.authorization || '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (req.headers['x-api-key'] ? String(req.headers['x-api-key']) : '');
    if (!key) return null;
    const t = this.tokenMap.get(key);
    if (!t || !t.enabled) return null;
    return t;
  }

  checkBudget(gk) {
    const g = this.config.groups[gk];
    if (!g || !g.budget) return { tripped: false };
    const usedToday = this.usage.groupCostToday(gk);
    const usedMonth = this.usage.groupCostMonth(gk);
    if (g.budget.dailyUSD > 0 && usedToday >= g.budget.dailyUSD) {
      return { tripped: true, reason: `组 ${gk} 今日预算已用尽（$${usedToday.toFixed(4)} / $${g.budget.dailyUSD}）` };
    }
    if (g.budget.monthlyUSD > 0 && usedMonth >= g.budget.monthlyUSD) {
      return { tripped: true, reason: `组 ${gk} 本月预算已用尽（$${usedMonth.toFixed(4)} / $${g.budget.monthlyUSD}）` };
    }
    return { tripped: false };
  }

  modelsPayload(clientToken) {
    const set = new Set();
    for (const c of this.config.channels) {
      if (!c.enabled) continue;
      if (clientToken && clientToken.allowGroups && !clientToken.allowGroups.includes(c.group)) continue;
      if (c.models.length) c.models.forEach((mm) => set.add(mm));
    }
    const now = Math.floor(Date.now() / 1000);
    return {
      object: 'list',
      data: Array.from(set).sort().map((id) => ({ id, object: 'model', created: now, owned_by: 'api-gateway' })),
    };
  }

  record(rec) {
    rec.ts = new Date().toISOString();
    this.usage.record(rec);
  }

  errBody(msg, type) {
    return { error: { message: msg, type: type || 'error', code: type || 'error' } };
  }

  log(level, msg) {
    const lv = this.config.server.logLevel || 'info';
    const order = { error: 0, warn: 1, info: 2, debug: 3 };
    if (order[level] > (order[lv] != null ? order[lv] : 2)) return;
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
  }

  // ---------------------------------------------------------------- 管理面

  serveDashboard(req, res) {
    const file = path.join(__dirname, '..', 'web', 'dashboard.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('状态页尚未生成（web/dashboard.html 缺失）');
    }
    const html = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }

  handleAdmin(req, res, pathname, url) {
    // 鉴权已在 handle() 里的 adminAllowed() 统一完成（登录会话 / adminToken / 本机直连），
    // 这里不再重复判断，避免「非本机 + 已登录」被下方的本机限制误伤。

    if (pathname === '/__gw/api/status') return sendJson(res, 200, this.statusPayload(req));
    if (pathname === '/__gw/api/channels') return sendJson(res, 200, this.channelsPayload());
    if (pathname === '/__gw/api/meta') {
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        providers: PROVIDERS,
        plans: PLANS,
        presets: PRESETS,
        groups: Object.entries(this.config.groups).map(([k, g]) => ({
          key: k,
          name: g.name,
          desc: g.desc,
          requireExplicit: !!g.requireExplicit,
          fallbackTo: g.fallbackTo || [],
          budget: g.budget || null,
        })),
      });
    }
    if (pathname === '/__gw/api/tokens') {
      // 客户端令牌：给的是可复制使用的全值，所以显式关掉缓存，别让浏览器留下副本
      return sendJson(res, 200, this.tokensPayload(), { 'cache-control': 'no-store' });
    }
    if (pathname === '/__gw/api/logs') {
      const limit = Math.min(500, Number(url.searchParams.get('limit')) || 50);
      return sendJson(res, 200, { ok: true, logs: this.usage.logs.slice(0, limit) });
    }
    if (pathname === '/__gw/api/cache/purge') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '需要 POST' });
      return sendJson(res, 200, { ok: true, purged: this.cache.purge() });
    }
    if (pathname === '/__gw/api/channel/toggle') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '需要 POST' });
      return this.readJsonBody(req, res, 1 << 16).then((read) => {
        if (!read.ok) return;
        const p = read.body;
        if (!p.id) return sendJson(res, 400, { ok: false, error: '缺少 id' });
        const target = this.config.channels.find((c) => c.id === p.id);
        if (!target) return sendJson(res, 404, { ok: false, error: '渠道不存在: ' + p.id });

        const want = p.enabled !== false;
        // 落盘 + 热更新，保证重启后仍然是这个启用状态
        const list = this.storedChannels().map((c) => (c.id === p.id ? Object.assign({}, c, { enabled: want }) : c));
        const r = this.persistChannels(list);
        if (!r.ok) return sendJson(res, 400, { ok: false, error: r.errors.join('; '), errors: r.errors });

        const h = this.health.get(p.id);
        if (h) {
          // 手动启用时顺手清掉冷却，避免「打开了却是灰的」
          if (want) {
            h.cooldownUntil = 0;
            h.cooldownLevel = 0;
            h.consecutiveFailures = 0;
          }
        }
        return sendJson(res, 200, { ok: true, id: p.id, enabled: want });
      });
    }
    if (pathname === '/__gw/api/channel/save') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '需要 POST' });
      return this.readJsonBody(req, res, 1 << 20).then((read) => {
        if (!read.ok) return;
        return this.handleChannelSave(req, res, read.body);
      });
    }
    if (pathname === '/__gw/api/channel/delete') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '需要 POST' });
      return this.readJsonBody(req, res, 1 << 20).then((read) => {
        if (!read.ok) return;
        const id = String(read.body.id || '').trim();
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' });
        const before = this.storedChannels();
        const after = before.filter((c) => c.id !== id);
        if (after.length === before.length) return sendJson(res, 404, { ok: false, error: '渠道不存在: ' + id });
        const saved = this.persistChannels(after);
        if (!saved.ok) return sendJson(res, 400, { ok: false, error: saved.errors.join('; '), errors: saved.errors });
        this.log('info', `渠道已删除：${id}（剩余 ${after.length} 个）`);
        return sendJson(res, 200, { ok: true, deleted: id, count: after.length });
      });
    }
    if (pathname === '/__gw/api/channel/test') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '需要 POST' });
      return this.readJsonBody(req, res, 1 << 20)
        .then((read) => {
          if (!read.ok) return;
          return this.handleChannelTest(res, read.body);
        })
        .catch((e) => sendJson(res, 200, { ok: false, latencyMs: 0, message: '测试失败：' + e.message }));
    }
    if (pathname === '/__gw/api/models/fetch') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '需要 POST' });
      return this.readJsonBody(req, res, 1 << 20)
        .then((read) => {
          if (!read.ok) return;
          return this.handleModelsFetch(res, read.body);
        })
        .catch((e) => sendJson(res, 200, { ok: false, models: [], latencyMs: 0, message: '获取失败：' + e.message }));
    }
    if (pathname === '/__gw/api/channel/reset') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '需要 POST' });
      return this.handleChannelReset(res);
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  }

  /**
   * 读取并解析 JSON 请求体，任何异常都转成明确的 HTTP 错误响应。
   *
   * 早前各接口都写成 readBody(req, n).then(...)，没有 .catch()。
   * 一旦请求体超限（超限会 reject）或客户端中途断开，Promise 被 reject 却没人接，
   * Node 会把它判定为未捕获异常 —— 整个进程直接退出。
   * 一个畸形请求就能打挂网关，在生产环境属于致命缺陷。
   *
   * @returns {Promise<{ok: boolean, body?: object}>} ok=false 时响应已写回，调用方直接 return
   */
  readJsonBody(req, res, limit) {
    return readBody(req, limit)
      .then((buf) => {
        let body;
        try {
          body = JSON.parse(buf.toString('utf8'));
        } catch (_) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          return { ok: false };
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, error: '请求体必须是一个 JSON 对象' });
          return { ok: false };
        }
        return { ok: true, body };
      })
      .catch((e) => {
        if (e && e.code === 'PAYLOAD_TOO_LARGE') {
          sendTooLarge(res, e.limit);
          return { ok: false };
        }
        this.log('warn', `读取请求体失败：${(e && e.message) || e}`);
        sendJson(res, 400, { ok: false, error: '读取请求体失败：' + ((e && e.message) || e) });
        return { ok: false };
      });
  }

  // ------------------------------------------------- 渠道增删改（具体实现）

  handleChannelSave(req, res, body) {
    const incoming = body.channel && typeof body.channel === 'object' ? body.channel : body;
    const originalId = String(body.originalId || incoming.id || '').trim();
    const id = String(incoming.id || '').trim();

    if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id（渠道标识）' });
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      return sendJson(res, 400, { ok: false, error: 'id 只能包含字母、数字、点、下划线和连字符' });
    }

    const list = this.storedChannels();
    const idx = list.findIndex((c) => c.id === (originalId || id));
    const created = idx < 0;

    if (created && list.some((c) => c.id === id)) {
      return sendJson(res, 409, { ok: false, error: `渠道 id 已存在：${id}` });
    }

    // 只挑白名单字段，页面传进来的杂项一律忽略
    const picked = {};
    for (const k of EDITABLE_FIELDS) {
      if (incoming[k] !== undefined && incoming[k] !== null) picked[k] = incoming[k];
    }
    picked.id = id;

    let next;
    if (created) {
      next = picked;
    } else {
      // 保存 = 局部更新：没传的字段沿用旧值，改个权重不该把 models 清空
      next = Object.assign({}, list[idx], picked);
    }

    // apiKey 单独处理，两个分支都要走：
    // 页面上永远拿不到明文，所以「留空」只能解释为「保持原密钥不变」；
    // 要真正清空必须显式传 clearApiKey: true。
    if (body.clearApiKey === true) {
      next.apiKey = '';
    } else if (incoming.apiKey != null && String(incoming.apiKey).trim() !== '') {
      next.apiKey = String(incoming.apiKey).trim();
    } else if (created) {
      next.apiKey = '';
    }

    const after = created ? list.concat([next]) : list.map((c, i) => (i === idx ? next : c));
    const r = this.persistChannels(after);
    if (!r.ok) return sendJson(res, 400, { ok: false, error: r.errors.join('; '), errors: r.errors });

    const saved = this.config.channels.find((c) => c.id === id);
    this.log('info', `渠道已${created ? '新增' : '更新'}：${id}（组 ${saved ? saved.group : '?'}）`);
    return sendJson(res, 200, {
      ok: true,
      created,
      channel: saved ? this.channelView(saved) : null,
      message: created ? `已新增渠道 ${id}` : `已更新渠道 ${id}`,
      count: r.channels.length,
    });
  }

  /**
   * 连通性测试
   *
   * 用最便宜的 GET {baseUrl}/models 探（不消耗 token），顺带把模型清单也带回来。
   * 端点不存在时（404/405）才退回一次 max_tokens=1 的最小对话请求 —— 网络不通时直接给结论，
   * 不再串第二次慢请求，避免「点了按钮一直转圈」。
   * 无论成功失败都返回 HTTP 200 —— 失败原因写在 ok/message 里，方便页面统一处理。
   */
  async handleChannelTest(res, body) {
    const t0 = Date.now();
    const target = this.resolveProbeTarget(body);
    if (target.error) {
      return sendJson(res, 200, { ok: false, latencyMs: 0, message: target.error });
    }
    const ch = target.channel;

    if (!ch.apiKey && ch.provider !== 'openai') {
      return sendJson(res, 200, { ok: false, latencyMs: 0, message: '该渠道没有配置 API Key，无法测试' });
    }

    const probe = await this.probeChannel(ch);
    const latencyMs = Date.now() - t0;

    if (probe.ok) {
      this.log('info', `渠道连通性测试通过：${ch.id}（${probe.via}，${latencyMs}ms）`);
    } else {
      this.log('warn', `渠道连通性测试失败：${ch.id} — ${probe.message}`);
    }

    return sendJson(res, 200, {
      ok: probe.ok,
      latencyMs,
      via: probe.via,
      status: probe.status,
      model: probe.model || null,
      models: probe.models || null,
      message: probe.message,
      tested: ch.id,
      temporary: target.temporary,
    });
  }

  async probeChannel(ch) {
    // 第一跳：GET /models。它同时能验证「网络可达 + 鉴权有效 + 取到模型清单」，
    // 所以它既是连通性测试，也是模型列表的来源，两件事共用一次请求。
    try {
      const r = await this.getUpstreamModels(ch, MODELS_PROBE_MS);
      return {
        ok: true,
        via: 'GET /models',
        status: 200,
        models: r.models,
        message: r.models.length
          ? `连接正常，鉴权通过，可用模型 ${r.models.length} 个`
          : '连接正常，鉴权通过（该端点未返回模型清单）',
      };
    } catch (e) {
      const st = e.httpStatus || 0;

      // 鉴权失败：答案很明确，不再做第二次请求
      if (st === 401 || st === 403) {
        return { ok: false, via: 'GET /models', status: st, message: e.message };
      }

      // 网络层失败（超时 / DNS / 连不上）：**直接返回，绝不发起第二跳**。
      // 以前这里会接着发一次最长 20s 的对话请求，两跳串起来最长 35s，
      // 用户看到的就是「一直转圈」。宁可快一点给出结论。
      if (!st) {
        return { ok: false, via: 'GET /models', status: 0, message: e.message };
      }

      // 端点确实不存在（404/405 等，说明上游响应很快）→ 才值得用最小对话请求再探一次
      return this.probeChannelByChat(ch, st);
    }
  }

  /** 取上游模型清单；非 2xx 抛错并带上 httpStatus，网络层错误则不带 */
  async getUpstreamModels(ch, timeoutMs) {
    const url = this.router.buildUrl(ch, 'models');
    const r = await fetchWithTimeout(url, { method: 'GET', headers: authHeaders(ch) }, timeoutMs || MODELS_PROBE_MS);
    if (r.status < 200 || r.status >= 300) {
      const err = new Error(
        r.status === 401 || r.status === 403
          ? `鉴权失败（HTTP ${r.status}）：API Key 可能无效、过期或权限不足`
          : `该地址的 GET /models 返回 HTTP ${r.status}：${snippet(r.text)}`
      );
      err.httpStatus = r.status;
      throw err;
    }
    return { models: parseModelList(r.text), url };
  }

  async probeChannelByChat(ch, modelsStatus) {
    const model = (ch.models.find((m) => !m.includes('*')) || '').trim();
    if (!model) {
      // 这里不再说「无法测试」——直说清发生了什么、下一步点哪里
      return {
        ok: false,
        via: 'GET /models',
        status: modelsStatus || 0,
        message:
          `该地址没有 /models 接口（HTTP ${modelsStatus || '?'}），且模型列表还是空的，没法进一步验证。\n` +
          '建议：先在 models 里填一个该厂商真实存在的模型名（如 deepseek-chat），再点测试。',
      };
    }

    const isAnthropic = ch.provider === 'anthropic';
    const path = isAnthropic ? 'messages' : 'chat/completions';
    const url = this.router.buildUrl(ch, path);
    const headers = Object.assign({ 'content-type': 'application/json' }, authHeaders(ch));
    const body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };

    try {
      const r = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) }, CHAT_PROBE_MS);
      if (r.status >= 200 && r.status < 300) {
        return { ok: true, via: `POST /${path}`, status: r.status, model, message: `连接正常，模型 ${model} 可用` };
      }
      return {
        ok: false,
        via: `POST /${path}`,
        status: r.status,
        model,
        message: `请求失败（${r.status}）：${snippet(r.text)}`,
      };
    } catch (e) {
      return { ok: false, via: `POST /${path}`, status: 0, model, message: '请求失败：' + e.message };
    }
  }

  /**
   * 从表单（可能还没保存）或已保存渠道里解析出「要拿去请求上游的那个渠道」
   * 测试连通性和获取模型列表共用同一套解析规则，避免两处行为不一致。
   */
  resolveProbeTarget(body) {
    const pick = body.channel && typeof body.channel === 'object' ? body.channel : null;
    const id = String((pick && pick.id) || body.id || '').trim();

    let saved = id ? this.config.channels.find((c) => c.id === id) || null : null;

    if (!pick) {
      if (!saved) return { error: id ? `未找到渠道：${id}` : '请提供渠道 id 或渠道参数' };
      return { channel: saved, id, temporary: false };
    }

    if (!pick.baseUrl) return { error: '请先填写上游地址 Base URL' };

    const v = validateChannelList([Object.assign({}, pick)], this.config);
    if (!v.channels.length) return { error: '渠道参数不合法（' + v.errors.join('；') + '）' };

    const ch = v.channels[0];
    // 表单里密钥留空 = 沿用已保存的那把（页面拿不到明文，只能后端补）
    if (!ch.apiKey && saved) ch.apiKey = saved.apiKey;
    return { channel: ch, id: ch.id, temporary: true, saved };
  }

  /** 一键获取上游模型列表 */
  async handleModelsFetch(res, body) {
    const t0 = Date.now();
    const target = this.resolveProbeTarget(body);
    if (target.error) {
      return sendJson(res, 200, { ok: false, models: [], latencyMs: 0, message: target.error });
    }
    const ch = target.channel;

    if (target.temporary && !ch.apiKey && ch.provider === 'openai') {
      // 本地 Ollama 这类无需鉴权的允许空 Key，但放开跑之前提醒一句
      this.log('debug', `获取模型列表：${ch.id} 未提供 API Key`);
    }

    try {
      const r = await this.getUpstreamModels(ch, MODELS_PROBE_MS);
      const latencyMs = Date.now() - t0;
      this.log('info', `获取模型列表成功：${ch.id} 共 ${r.models.length} 个（${latencyMs}ms）`);
      return sendJson(res, 200, {
        ok: true,
        models: r.models,
        count: r.models.length,
        via: 'GET /models',
        status: 200,
        latencyMs,
        message: r.models.length
          ? `获取到 ${r.models.length} 个模型，点一下就加进列表`
          : '连接和鉴权都正常，但这个端点没返回模型清单，需要手动填模型名',
      });
    } catch (e) {
      const latencyMs = Date.now() - t0;
      const st = e.httpStatus || 0;
      const hint =
        st === 401 || st === 403
          ? '\nAPI Key 看起来无效或权限不足，请检查后重试。'
          : st
            ? '\n该厂商可能不提供 /models 接口，只能手动填写模型名。'
            : '\n请检查网络，或确认这个地址在当前网络下能访问。';
      this.log('warn', `获取模型列表失败：${ch.id} — ${e.message}`);
      return sendJson(res, 200, {
        ok: false,
        models: [],
        count: 0,
        via: 'GET /models',
        status: st,
        latencyMs,
        message: e.message + hint,
      });
    }
  }

  /** 删除渠道库，回到 gateway.yaml 的 channels 基线 */
  handleChannelReset(res) {
    if (!this.store.exists()) {
      return sendJson(res, 400, { ok: false, error: '当前渠道本来就来自 gateway.yaml，无需重置' });
    }
    const cfgFile = this.configPath || this.config.__file;
    if (!cfgFile) {
      return sendJson(res, 400, {
        ok: false,
        error: '当前实例不是从配置文件启动的（例如演示实例），没有可回退的 YAML 基线。请手动删除 data/channels.json。',
      });
    }

    let fresh;
    try {
      fresh = require('./config').load(cfgFile);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: 'YAML 基线校验未通过，未执行重置：' + e.message });
    }

    this.store.remove(); // 备份为 channels.json.bak
    this.applyChannels(fresh.channels);
    this.log('info', `渠道已重置回 gateway.yaml 基线（${fresh.channels.length} 个）`);
    return sendJson(res, 200, {
      ok: true,
      source: 'yaml',
      count: fresh.channels.length,
      channels: this.config.channels.map((c) => this.channelView(c)),
      message: `已重置回 gateway.yaml 的 ${fresh.channels.length} 个渠道（原文件已备份为 channels.json.bak）`,
    });
  }

  statusPayload(req) {
    const now = Date.now();
    const groups = {};
    for (const [k, g] of Object.entries(this.config.groups)) {
      const chs = this.config.channels.filter((c) => c.group === k);
      groups[k] = {
        key: k,
        name: g.name,
        desc: g.desc,
        requireExplicit: !!g.requireExplicit,
        fallbackTo: g.fallbackTo || [],
        total: chs.length,
        healthy: chs.filter((c) => this.health.get(c.id).isAvailable(now)).length,
        requests: this.usage.byGroup[k] ? this.usage.byGroup[k].requests : 0,
        costUSD: round6(this.usage.groupCostMonth(k)),
        costTodayUSD: round6(this.usage.groupCostToday(k)),
      };
    }

    const channels = this.config.channels.map((c) => {
      const h = this.health.get(c.id);
      const ls = this.limiter.snapshot('channel:' + c.id, c.limits);
      return {
        id: c.id,
        name: c.name,
        group: c.group,
        provider: c.provider,
        plan: c.plan,
        baseUrl: c.baseUrl,
        models: c.models,
        enabled: h.enabled,
        healthy: h.isAvailable(now),
        cooldownUntil: h.cooldownUntil ? new Date(h.cooldownUntil).toISOString() : null,
        cooldownRemainSec: h.cooldownRemainSec,
        weight: c.weight,
        priority: c.priority,
        lastError: h.lastError,
        stats: h.snapshot(),
        limits: c.limits,
        runtime: ls,
      };
    });

    const usageSnap = this.usage.snapshot();
    const byModelObj = {};
    for (const m of usageSnap.byModel) {
      const { model, ...rest } = m;
      byModelObj[model] = rest;
    }

    const budget = {};
    for (const [k, g] of Object.entries(this.config.groups)) {
      if (!g.budget) continue;
      const usedToday = this.usage.groupCostToday(k);
      const usedMonth = this.usage.groupCostMonth(k);
      budget[k] = {
        dailyLimitUSD: g.budget.dailyUSD,
        dailyUsedUSD: round6(usedToday),
        dailyRemainUSD: round6(Math.max(0, g.budget.dailyUSD - usedToday)),
        monthlyLimitUSD: g.budget.monthlyUSD,
        monthlyUsedUSD: round6(usedMonth),
        monthlyRemainUSD: round6(Math.max(0, g.budget.monthlyUSD - usedMonth)),
        tripped: g.budget.dailyUSD > 0 ? usedToday >= g.budget.dailyUSD : false,
        tripReason: null,
      };
    }

    return {
      ok: true,
      version: VERSION,
      uptimeSec: Math.floor((now - this.startedAt.getTime()) / 1000),
      startedAt: this.startedAt.toISOString(),
      serverTime: new Date().toISOString(),
      listen: `${this.config.server.host}:${this.config.server.port}`,
      policy: {
        fallbackChain: this.config.fallback.chain,
        cGroupRequiresExplicit: !!(this.config.groups.C && this.config.groups.C.requireExplicit),
        authRequired: this.requireAuth,
      },
      // 管理面登录状态：页面据此决定要不要显示「退出登录」
      admin: {
        loginEnabled: this.auth.enabled,
        user: (this.auth.session(req) || {}).user || null,
      },
      groups,
      channels,
      usage: {
        today: usageSnap.today,
        month: usageSnap.month,
        byGroup: usageSnap.byGroup,
        byModel: byModelObj,
      },
      budget,
      cache: this.cache.snapshot(),
    };
  }
}

// ------------------------------------------------------------------ 工具

/**
 * 登录后的跳转目标白名单
 * 只接受站内 /__gw 开头的绝对路径：
 * 挡掉 `//evil.com`（协议相对）与 `/\evil.com` 这类开放重定向写法。
 */
function safeNextPath(v) {
  const s = String(v || '');
  if (!s.startsWith('/__gw') || s.startsWith('//') || s.includes('\\')) return '/__gw/';
  return s;
}

/**
 * 定长比较字符串，避免通过响应时间逐字节猜出令牌。
 * 先比长度会泄露长度信息，所以改成对「同长度摘要」做比较：
 * 长度不同也不会提前返回，整体耗时恒定。
 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * 把不可信字符串压成单行，用于日志。
 * 否则攻击者提交 `admin\n2026-09-14 登录成功：user="admin"` 这类带换行的用户名，
 * 就能在日志里伪造出一条看起来合法的记录。
 */
function oneLine(v, maxLen) {
  const s = String(v == null ? '' : v).replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim();
  return s.length > (maxLen || 200) ? s.slice(0, maxLen || 200) + '…' : s;
}

function payloadTooLarge(limit) {
  const err = new Error(`请求体超过上限 ${limit} 字节`);
  err.code = 'PAYLOAD_TOO_LARGE';
  err.limit = limit;
  return err;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };

    // 先看 Content-Length：已经超限时就不必再往内存里攒分片了。
    // 注意这里**不能** req.destroy() —— 那会把底层 socket 一起拆掉，
    // 413 响应根本发不出去，客户端只会看到一个 ECONNRESET。
    // 正确做法是把剩余数据排空（不缓存），让服务端把错误响应正常写完。
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      fail(payloadTooLarge(limit));
      return;
    }

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        chunks.length = 0; // 立刻释放已缓存的分片，内存占用回到 0
        req.resume(); // 继续排空但不保存
        fail(payloadTooLarge(limit));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => fail(e));
  });
}

function tryParseJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    return null;
  }
}

/** 不解析整个 JSON，只快速定位 "model":"xxx"，避免大 body 的解析开销 */
function extractModelFast(buf) {
  const s = buf.toString('utf8', 0, Math.min(buf.length, 8192));
  const m = /"model"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s);
  return m ? m[1] : null;
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'Content-Type,Authorization,X-API-Key,X-GW-Group,X-Admin-Token',
    'access-control-max-age': '600',
  };
}

function sendJson(res, status, obj, extraHeaders) {
  if (res.writableEnded) return;
  try {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'content-length': body.length }, extraHeaders || {}));
    res.end(body);
  } catch (e) {
    // 连接已被客户端断开或已销毁。写不回去就算了 ——
    // 但绝不能让这个异常冒泡出去变成未捕获异常把进程带崩。
    try {
      res.destroy();
    } catch (_) {}
  }
}

/**
 * 写回已拿到的上游响应体（错误分支用）。
 * 与 sendJson 同理：客户端可能已经走人了，写失败要静默收场。
 */
function writeRaw(res, status, headers, body) {
  if (res.writableEnded) return;
  try {
    res.writeHead(status, headers);
    res.end(body);
  } catch (e) {
    try {
      res.destroy();
    } catch (_) {}
  }
}

/**
 * 413 响应。附带 Connection: close —— 请求体还没读完就拒绝，
 * 这条连接不该被复用，关掉更干净。
 */
function sendTooLarge(res, limit, extraHeaders) {
  sendJson(
    res,
    413,
    { error: { message: `请求体过大，上限 ${limit} 字节（可在 gateway.yaml 调 server.maxBodyBytes）`, type: 'payload_too_large', code: 'payload_too_large' } },
    Object.assign({ connection: 'close' }, extraHeaders || {})
  );
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** 带超时的 fetch（渠道连通性测试专用；只在管理接口调用，不在数据面关键路径上） */
async function fetchWithTimeout(url, opts, timeoutMs) {
  if (typeof fetch !== 'function') {
    throw new Error('当前 Node 版本不支持 fetch（需 Node 18+），请升级 Node 后重试');
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, Object.assign({ signal: ac.signal, redirect: 'follow' }, opts));
    const text = await r.text().catch(() => '');
    return { status: r.status, text };
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function snippet(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 200 ? t.slice(0, 200) + '…' : t || '(空响应)';
}

/**
 * 解析各家的 /models 响应，抽出模型名
 *
 * 覆盖到的形状：
 *   OpenAI / Anthropic / 绝大多数国产兼容 → { object:'list', data:[{ id }] }
 *   Google Gemini                        → { models:[{ name:'models/gemini-2.5-pro' }] }
 *   本地 Ollama                          → { models:[{ name:'llama3' }] }
 *   裸数组                               → [{ id }] 或 ['gpt-4o']
 *   套一层的                              → { data:{ models:[...] } } 等
 *
 * 刻意**不做**「递归乱扫」兜底：聊天响应体里也有 id/model 字段，
 * 乱扫会把 chatcmpl-xxx 当成模型名塞进列表，用户一点就保存进配置。
 * 认不出来就返回空数组，由调用方如实告知「这个端点没返回模型清单」。
 */
function parseModelList(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch (_) {
    return [];
  }

  const out = [];
  const seen = new Set();
  const push = (v) => {
    if (typeof v !== 'string') return;
    // Gemini 的 name 形如 models/gemini-2.5-pro；把版本前缀剥掉
    const s = v.trim().replace(/^models\//, '');
    if (!s || s.length > 200 || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  const pickArray = (...candidates) => {
    for (const c of candidates) if (Array.isArray(c)) return c;
    return null;
  };

  const arr =
    (Array.isArray(j) && j) ||
    pickArray(j && j.data, j && j.models, j && j.result, j && j.model_list) ||
    pickArray(j && j.data && j.data.models, j && j.data && j.data.data, j && j.result && j.result.models) ||
    null;

  if (arr) {
    for (const it of arr) {
      if (typeof it === 'string') {
        push(it);
        continue;
      }
      if (!it || typeof it !== 'object') continue;
      push(it.id || it.name || it.model || it.model_id);
    }
  }

  out.sort((a, b) => a.localeCompare(b));
  return out;
}

module.exports = { GatewayServer, VERSION, parseModelList };
