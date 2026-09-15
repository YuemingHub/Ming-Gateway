'use strict';

/**
 * 管理面登录（状态页 + 管理接口）
 *
 * 为什么需要它：网关一旦监听 0.0.0.0，任何扫到端口的人都能打开状态页、
 * 看到你的渠道配置、顺手改掉或删掉渠道。数据面的 /v1/* 有 tokens 挡着，
 * 但管理面必须有独立的一道门。
 *
 * 设计取舍（刻意保持简单，与「零依赖单进程」的定位一致）：
 *   - 会话存在进程内存里：单进程自用足够；重启后需要重新登录（这是可接受的）。
 *   - 密码比对用 timingSafeEqual，避免按字符逐位试探。
 *   - 同一 IP 连续失败达上限就临时拒绝，防止在线暴力破解。
 *   - Cookie 为 HttpOnly + SameSite=Lax：Lax 意味着跨站 POST 不会带上它，
 *     因此管理接口的写操作不会被第三方页面利用（无需额外 CSRF token）。
 *   - 不做「记住用户名」、不做多用户、不做找回密码 —— 一人公司场景不需要。
 */

const crypto = require('crypto');

const COOKIE_NAME = 'gw_sid';

function sha256(v) {
  return crypto.createHash('sha256').update(String(v), 'utf8').digest();
}

/** 定长比较，避免通过响应时间推断密码前缀 */
function safeEqual(a, b) {
  const ba = sha256(a);
  const bb = sha256(b);
  return crypto.timingSafeEqual(ba, bb);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch (_) {}
    out[k] = v;
  }
  return out;
}

/**
 * 取客户端 IP。
 *
 * 只有显式开启 server.trustProxy 时才采信 X-Forwarded-For。
 *
 * ⚠️ 采信时**取最右一段**，绝不能取最左：反代用的是 $proxy_add_x_forwarded_for，
 * 头的形状是「<客户端自己带的>, <真实对端>」——最左边那段可以由客户端随意伪造，
 * 取它等于把「同一 IP 连续失败 N 次就拒绝」这把锁的钥匙交给攻击者：
 *   1) 每次换一个假 IP 就是一只全新的失败计数桶，防爆破完全失效；
 *   2) 还能用海量伪造 IP 把失败记录表撑到内存耗尽。
 * 最右边那段是最近一跳受信代理看到的对端，公网伪造的头会被它顶掉。
 *
 * 诚实客户端不带这个头，左右本就是同一个值，所以取最右没有行为变化；
 * 完全没带头（含本机直连）时，照旧回落到 socket 地址。
 */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** 失败记录表的最大条目数。超过后丢弃最旧的一半，防止被刷到内存耗尽 */
const MAX_FAILURE_ENTRIES = 10000;

class Auth {
  constructor(cfg, log) {
    this.cfg = cfg || {};
    this.log = typeof log === 'function' ? log : () => {};
    this.enabled = this.cfg.enabled === true;
    this.trustProxy = this.cfg.trustProxy === true;
    this.sessions = new Map(); // token -> { user, expiresAt, ip, createdAt }
    this.failures = new Map(); // ip -> { count, firstAt, blockedUntil }
  }

  /** 定时清理过期会话与失败记录，避免内存随运行时间无界增长 */
  sweep() {
    const now = Date.now();
    for (const [k, v] of this.sessions) {
      if (v.expiresAt <= now) this.sessions.delete(k);
    }
    for (const [k, v] of this.failures) {
      const stale = now - v.firstAt > this.cfg.failureWindowSec * 1000;
      const unblocked = !v.blockedUntil || v.blockedUntil <= now;
      if (stale && unblocked) this.failures.delete(k);
    }
  }

  /** 该 IP 是否因失败过多被暂时拒绝 */
  blockedFor(ip) {
    const f = this.failures.get(ip);
    if (!f) return 0;
    if (f.blockedUntil && f.blockedUntil > Date.now()) {
      return Math.ceil((f.blockedUntil - Date.now()) / 1000);
    }
    return 0;
  }

  noteFailure(ip) {
    const now = Date.now();
    let f = this.failures.get(ip);
    if (!f || now - f.firstAt > this.cfg.failureWindowSec * 1000) {
      // 表满了先腾地方：按插入顺序丢掉最早的一半（Map 保持插入序）
      if (!f && this.failures.size >= MAX_FAILURE_ENTRIES) {
        let drop = Math.floor(MAX_FAILURE_ENTRIES / 2);
        for (const k of this.failures.keys()) {
          if (drop-- <= 0) break;
          this.failures.delete(k);
        }
      }
      f = { count: 0, firstAt: now, blockedUntil: 0 };
      this.failures.set(ip, f);
    }
    f.count++;
    if (f.count >= this.cfg.maxFailures) {
      f.blockedUntil = now + this.cfg.failureWindowSec * 1000;
      f.count = 0;
      f.firstAt = now;
      this.log('warn', `登录失败次数过多，已暂时拒绝 ${ip}（${this.cfg.failureWindowSec}s）`);
    }
  }

  clearFailures(ip) {
    this.failures.delete(ip);
  }

  verify(username, password) {
    if (!this.enabled) return false;
    const uOk = safeEqual(username || '', this.cfg.username);
    const pOk = safeEqual(password || '', this.cfg.password);
    // 两个都算完再合并，避免「用户名错」比「密码错」返回得更快
    return uOk && pOk;
  }

  /** 签发会话并写入 Cookie */
  issue(req, res, username) {
    const token = crypto.randomBytes(32).toString('base64url');
    const ttlMs = this.cfg.sessionTtlSec * 1000;
    this.sessions.set(token, {
      user: username,
      expiresAt: Date.now() + ttlMs,
      createdAt: Date.now(),
      ip: clientIp(req, this.trustProxy),
    });
    const flags = [
      `${COOKIE_NAME}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${this.cfg.sessionTtlSec}`,
    ];
    if (this.cfg.cookieSecure) flags.push('Secure');
    res.setHeader('Set-Cookie', flags.join('; '));
    return token;
  }

  revoke(req, res) {
    const token = parseCookies(req.headers && req.headers.cookie)[COOKIE_NAME];
    if (token) this.sessions.delete(token);
    const flags = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (this.cfg.cookieSecure) flags.push('Secure');
    res.setHeader('Set-Cookie', flags.join('; '));
  }

  /** 当前请求的会话；未登录返回 null */
  session(req) {
    if (!this.enabled || !req) return null;
    const token = parseCookies(req.headers && req.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return s;
  }

  isLoggedIn(req) {
    return !!this.session(req);
  }

  get sessionCount() {
    return this.sessions.size;
  }

  // ---------------------------------------------------------------- 登录页

  /**
   * 登录页。单文件、无外部资源 —— 与状态页保持一致，
   * 断网 / 内网环境下也能正常渲染。
   */
  page(opts) {
    const o = opts || {};
    const err = o.error ? `<div class="err">${esc(o.error)}</div>` : '';
    const next = o.next ? `<input type="hidden" name="next" value="${esc(o.next)}">` : '';
    const note = o.note ? `<div class="note">${esc(o.note)}</div>` : '';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>登录 · 统一 API 网关</title>
<style>
  :root { --bg:#0d1117; --card:#161b22; --line:#30363d; --tx:#e6edf3; --dim:#8b949e; --blue:#2f81f7; --red:#f85149; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:var(--bg); color:var(--tx);
         font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
  .box { width:100%; max-width:360px; padding:32px 28px; background:var(--card);
         border:1px solid var(--line); border-radius:12px; }
  h1 { margin:0 0 4px; font-size:19px; font-weight:600; }
  .sub { margin:0 0 22px; color:var(--dim); font-size:12.5px; }
  label { display:block; margin-bottom:6px; color:var(--dim); font-size:12.5px; }
  input[type=text], input[type=password] {
    width:100%; padding:10px 12px; margin-bottom:14px;
    background:#0d1117; color:var(--tx); border:1px solid var(--line); border-radius:8px;
    font-size:14px; outline:none;
  }
  input:focus { border-color:var(--blue); }
  button { width:100%; padding:11px; margin-top:4px; background:var(--blue); color:#fff;
           border:0; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; }
  button:hover { filter:brightness(1.1); }
  .err { margin-bottom:16px; padding:9px 12px; border-radius:8px; font-size:13px;
         background:rgba(248,81,73,.12); border:1px solid rgba(248,81,73,.4); color:var(--red); }
  .note { margin-top:18px; padding-top:14px; border-top:1px solid var(--line);
          color:var(--dim); font-size:12px; }
</style>
</head>
<body>
  <form class="box" method="post" action="/__gw/login" autocomplete="off">
    <h1>统一 API 网关</h1>
    <p class="sub">请登录后访问管理面</p>
    ${err}
    ${next}
    <label for="u">用户名</label>
    <input id="u" name="username" type="text" autocomplete="username" autofocus required>
    <label for="p">密码</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">登录</button>
    ${note}
  </form>
</body>
</html>`;
  }
}

module.exports = { Auth, COOKIE_NAME, parseCookies, clientIp };
