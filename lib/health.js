'use strict';

/**
 * 渠道健康度与冷却
 *
 * 策略（借鉴 one-api 的渠道冷却思路）：
 *   连续失败达到阈值 → 进入冷却，冷却时长按 2^n 指数退避，上限 maxSec；
 *   任意一次成功 → 冷却与连续失败计数全部清零。
 *   这样偶发抖动只冷却 60s，真正挂掉的渠道会逐步退到 15 分钟才重试。
 */

const LATENCY_WINDOW = 100;

class ChannelHealth {
  constructor(channel) {
    this.id = channel.id;
    this.enabled = channel.enabled;
    this.cooldownCfg = channel.cooldown;
    this.consecutiveFailures = 0;
    this.cooldownUntil = 0;
    this.cooldownLevel = 0;
    this.lastError = null;
    this.lastUsedAt = null;
    this.total = 0;
    this.success = 0;
    this.failed = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.costUSD = 0;
    this._latencies = [];
    this._latencySum = 0;
  }

  markSuccess(latencyMs, usage) {
    this.total++;
    this.success++;
    this.consecutiveFailures = 0;
    this.cooldownUntil = 0;
    this.cooldownLevel = 0;
    this.lastError = null;
    this.lastUsedAt = new Date().toISOString();

    this._latencies.push(latencyMs);
    this._latencySum += latencyMs;
    if (this._latencies.length > LATENCY_WINDOW) {
      this._latencySum -= this._latencies.shift();
    }

    if (usage) {
      this.promptTokens += usage.promptTokens || 0;
      this.completionTokens += usage.completionTokens || 0;
      this.costUSD += usage.costUSD || 0;
    }
  }

  markFailure(errMsg, opts) {
    const noCount = opts && opts.noCount; // 客户端主动取消等不计入失败
    this.total++;
    if (!noCount) {
      this.failed++;
      this.consecutiveFailures++;
    }
    this.lastError = String(errMsg || 'unknown').slice(0, 500);
    this.lastUsedAt = new Date().toISOString();

    if (!noCount) {
      const cfg = this.cooldownCfg || { baseSec: 60, maxSec: 900, failThreshold: 3 };
      if (this.consecutiveFailures >= (cfg.failThreshold || 3)) {
        this.cooldownLevel = Math.min(this.cooldownLevel + 1, 10);
        const sec = Math.min((cfg.baseSec || 60) * Math.pow(2, this.cooldownLevel - 1), cfg.maxSec || 900);
        this.cooldownUntil = Date.now() + sec * 1000;
        return { cooled: true, cooldownSec: sec };
      }
    }
    return { cooled: false, cooldownSec: 0 };
  }

  /** 手动冷却（配额窗口耗尽等场景） */
  coolFor(sec, reason) {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + sec * 1000);
    if (reason) this.lastError = String(reason).slice(0, 500);
  }

  isAvailable(now) {
    if (!this.enabled) return false;
    if (this.cooldownUntil && now < this.cooldownUntil) return false;
    return true;
  }

  get cooldownRemainSec() {
    if (!this.cooldownUntil) return 0;
    return Math.max(0, Math.ceil((this.cooldownUntil - Date.now()) / 1000));
  }

  get successRate() {
    return this.total > 0 ? this.success / this.total : 1;
  }

  get avgLatencyMs() {
    return this._latencies.length ? Math.round(this._latencySum / this._latencies.length) : 0;
  }

  get p95LatencyMs() {
    if (!this._latencies.length) return 0;
    const sorted = this._latencies.slice().sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    return sorted[idx];
  }

  snapshot() {
    return {
      total: this.total,
      success: this.success,
      failed: this.failed,
      successRate: Math.round(this.successRate * 10000) / 10000,
      avgLatencyMs: this.avgLatencyMs,
      p95LatencyMs: this.p95LatencyMs,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      costUSD: Math.round(this.costUSD * 1e6) / 1e6,
      lastUsedAt: this.lastUsedAt,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

class HealthRegistry {
  constructor(channels) {
    this.map = new Map();
    for (const c of channels) this.map.set(c.id, new ChannelHealth(c));
  }

  get(channelId) {
    return this.map.get(channelId);
  }

  setEnabled(channelId, enabled) {
    const h = this.map.get(channelId);
    if (!h) return false;
    h.enabled = !!enabled;
    if (enabled) {
      h.cooldownUntil = 0;
      h.cooldownLevel = 0;
      h.consecutiveFailures = 0;
    }
    return true;
  }

  /**
   * 热更新渠道列表（页面增删改渠道后调用，不重启进程）
   * 同 id 的渠道保留全部历史统计与冷却状态 —— 改个权重不该把统计清零；
   * 新增的建新记录，被删掉的直接移除。
   */
  sync(channels) {
    const next = new Map();
    for (const c of channels) {
      const existing = this.map.get(c.id);
      if (existing) {
        existing.cooldownCfg = c.cooldown || existing.cooldownCfg;
        existing.groupKey = c.group;
        existing.enabled = c.enabled !== false;
        next.set(c.id, existing);
      } else {
        next.set(c.id, new ChannelHealth(c));
      }
    }
    this.map = next;
  }

  availableCount(groupKey, now) {
    let n = 0;
    for (const h of this.map.values()) {
      if (h.groupKey === groupKey && h.isAvailable(now)) n++;
    }
    return n;
  }
}

module.exports = { ChannelHealth, HealthRegistry };
