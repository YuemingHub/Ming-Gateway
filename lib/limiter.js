'use strict';

/**
 * 限流三件套：RPM / TPM 令牌桶、并发闸门、配额窗口
 *
 * 设计前提：个人自用，单机内存态即可，不引入 Redis。
 * 所有数据结构都是 O(1) 读写，不在关键路径上做遍历。
 */

class TokenBucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.updatedAt = Date.now();
  }

  /** 尝试取 n 个令牌；不足返回还需要等多少毫秒 */
  take(n) {
    this._refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return { ok: true, retryAfterMs: 0 };
    }
    const need = n - this.tokens;
    const waitMs = Math.ceil((need / this.refillPerSec) * 1000);
    return { ok: false, retryAfterMs: waitMs };
  }

  /** 归还令牌：请求前按估算预扣、响应后按实际用量校正 */
  give(n) {
    this._refill();
    this.tokens = Math.min(this.capacity, this.tokens + n);
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.updatedAt) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.updatedAt = now;
  }

  get remaining() {
    this._refill();
    return Math.floor(this.tokens);
  }
}

/**
 * 多维度限流器
 * key 形如 "channel:deepseek-main" / "token:dev-local" / "group:C"
 */
class Limiter {
  constructor() {
    this.rpm = new Map();
    this.tpm = new Map();
    this.concurrency = new Map();
    this.windows = new Map();
  }

  _bucket(map, key, capacity, perSec) {
    let b = map.get(key);
    if (!b || b.capacity !== capacity) {
      b = new TokenBucket(capacity, perSec);
      map.set(key, b);
    }
    return b;
  }

  /**
   * 准入检查（不消耗）
   * @param {object} limits {rpm, tpm, concurrency, windowSec, windowMaxRequests, windowMaxTokens}
   * @param {number} estTokens 预留的 token 估算（prompt tokens）
   */
  check(key, limits, estTokens) {
    const now = Date.now();
    const res = { ok: true, reason: null, retryAfterMs: 0 };

    if (limits.rpm > 0) {
      const b = this._bucket(this.rpm, key + ':rpm', limits.rpm, limits.rpm / 60);
      const r = b.take(0);
      if (b.remaining < 1) {
        res.ok = false;
        res.reason = 'rpm';
        res.retryAfterMs = Math.max(res.retryAfterMs, r.retryAfterMs || 1000);
      }
    }
    if (limits.tpm > 0) {
      const b = this._bucket(this.tpm, key + ':tpm', limits.tpm, limits.tpm / 60);
      if (b.remaining < estTokens) {
        res.ok = false;
        res.reason = 'tpm';
        res.retryAfterMs = Math.max(res.retryAfterMs, 1000);
      }
    }
    if (limits.concurrency > 0) {
      const cur = this.concurrency.get(key) || 0;
      if (cur >= limits.concurrency) {
        res.ok = false;
        res.reason = 'concurrency';
        res.retryAfterMs = Math.max(res.retryAfterMs, 500);
      }
    }
    if (limits.windowSec > 0 && (limits.windowMaxRequests > 0 || limits.windowMaxTokens > 0)) {
      const w = this._window(key, limits.windowSec);
      if (limits.windowMaxRequests > 0 && w.requests >= limits.windowMaxRequests) {
        res.ok = false;
        res.reason = 'window_requests';
        res.retryAfterMs = Math.max(res.retryAfterMs, w.resetAt - now);
      } else if (limits.windowMaxTokens > 0 && w.tokens + estTokens > limits.windowMaxTokens) {
        res.ok = false;
        res.reason = 'window_tokens';
        res.retryAfterMs = Math.max(res.retryAfterMs, w.resetAt - now);
      }
    }
    return res;
  }

  /** 真正占用（请求发出前调用） */
  acquire(key, limits, estTokens) {
    if (limits.rpm > 0) this._bucket(this.rpm, key + ':rpm', limits.rpm, limits.rpm / 60).take(1);
    if (limits.tpm > 0) this._bucket(this.tpm, key + ':tpm', limits.tpm, limits.tpm / 60).take(estTokens);
    if (limits.concurrency > 0) this.concurrency.set(key, (this.concurrency.get(key) || 0) + 1);

    if (limits.windowSec > 0) {
      const w = this._window(key, limits.windowSec);
      w.requests += 1;
      w.tokens += estTokens || 0;
    }
  }

  /**
   * 请求结束，按真实用量校正 token 桶并归还并发
   * @param {number} estTokens 请求前的预扣值
   * @param {number} realTokens 实际消耗（prompt+completion）
   */
  release(key, limits, estTokens, realTokens) {
    if (limits.concurrency > 0) {
      const cur = this.concurrency.get(key) || 0;
      this.concurrency.set(key, Math.max(0, cur - 1));
    }
    if (limits.tpm > 0) {
      const b = this._bucket(this.tpm, key + ':tpm', limits.tpm, limits.tpm / 60);
      const diff = (estTokens || 0) - (realTokens || 0);
      if (diff > 0) b.give(diff); // 预扣多了，还回去
      else if (diff < 0) b.take(-diff); // 预扣少了，补扣（允许瞬时透支）
    }
  }

  /** 并发失败时也要归还 */
  releaseConcurrency(key) {
    const cur = this.concurrency.get(key) || 0;
    this.concurrency.set(key, Math.max(0, cur - 1));
  }

  _window(key, windowSec) {
    const now = Date.now();
    let w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
      w = { startedAt: now, resetAt: now + windowSec * 1000, requests: 0, tokens: 0 };
      this.windows.set(key, w);
    }
    return w;
  }

  /** 供状态页展示 */
  snapshot(key, limits) {
    const out = { inflight: this.concurrency.get(key) || 0 };
    if (limits.rpm > 0) out.rpmRemaining = this._bucket(this.rpm, key + ':rpm', limits.rpm, limits.rpm / 60).remaining;
    if (limits.tpm > 0) out.tpmRemaining = this._bucket(this.tpm, key + ':tpm', limits.tpm, limits.tpm / 60).remaining;
    if (limits.windowSec > 0) {
      const w = this._window(key, limits.windowSec);
      out.window = {
        requests: w.requests,
        maxRequests: limits.windowMaxRequests || 0,
        tokens: w.tokens,
        maxTokens: limits.windowMaxTokens || 0,
        resetInSec: Math.max(0, Math.ceil((w.resetAt - Date.now()) / 1000)),
      };
    }
    return out;
  }
}

module.exports = { Limiter, TokenBucket };
