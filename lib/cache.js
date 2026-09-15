'use strict';

const crypto = require('crypto');

/**
 * 响应缓存（仅非流式请求）
 *
 * 只对确定性请求生效：temperature 为 0 或省略时才缓存。
 * 缓存命中直接返回，成本计 0 —— 这是 C 组控本最有效的一招。
 */

class ResponseCache {
  constructor(cfg) {
    this.enabled = !!(cfg && cfg.enabled);
    this.ttlSec = (cfg && cfg.ttlSec) || 600;
    this.maxEntries = (cfg && cfg.maxEntries) || 2000;
    this.onlyDeterministic = cfg && cfg.onlyDeterministic === false ? false : true;
    this.map = new Map(); // key -> { value, expireAt }
    this.hits = 0;
    this.misses = 0;
  }

  /** 是否允许缓存该请求 */
  shouldCache(body) {
    if (!this.enabled) return false;
    if (body && body.stream === true) return false;
    if (this.onlyDeterministic) {
      const t = body && body.temperature;
      if (t != null && Number(t) > 0) return false;
    }
    return true;
  }

  key(model, body) {
    const norm = {
      model,
      messages: body && body.messages,
      temperature: body && body.temperature,
      top_p: body && body.top_p,
      max_tokens: body && body.max_tokens,
      response_format: body && body.response_format,
      tools: body && body.tools,
      tool_choice: body && body.tool_choice,
    };
    return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 32);
  }

  get(key) {
    if (!this.enabled) return null;
    const hit = this.map.get(key);
    if (!hit) {
      this.misses++;
      return null;
    }
    if (Date.now() > hit.expireAt) {
      this.map.delete(key);
      this.misses++;
      return null;
    }
    // LRU：命中后挪到末尾
    this.map.delete(key);
    this.map.set(key, hit);
    this.hits++;
    return hit.value;
  }

  set(key, value, ttlSec) {
    if (!this.enabled) return;
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    const ttl = (ttlSec || this.ttlSec) * 1000;
    this.map.set(key, { value, expireAt: Date.now() + ttl });
  }

  purge() {
    const n = this.map.size;
    this.map.clear();
    return n;
  }

  snapshot() {
    const total = this.hits + this.misses;
    return {
      enabled: this.enabled,
      entries: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? Math.round((this.hits / total) * 1000) / 1000 : 0,
    };
  }
}

module.exports = { ResponseCache };
