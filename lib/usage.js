'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 用量统计与请求日志
 *
 * 关键性能约束：统计绝不能阻塞响应。
 * 所有写入走「内存累加 + 定时批量落盘」，日志用环形缓冲。
 */

const FLUSH_INTERVAL_MS = 10000;
const LOG_BUFFER_MAX = 500;

class Usage {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.startedAt = new Date();
    fs.mkdirSync(dataDir, { recursive: true });

    this.today = blankStat();
    this.month = blankStat();
    this.byGroup = {};
    this.byModel = {};
    this.byDay = {}; // 'YYYY-MM-DD' -> stat，用于预算与按月汇总
    this.logs = [];

    this._pending = [];
    this._dirty = false;
    this._timer = null;

    this._restoreToday();
    this._restoreMonth();
  }

  dayKey(d) {
    const dt = d || new Date();
    return dt.toISOString().slice(0, 10);
  }
  monthKey(d) {
    return this.dayKey(d).slice(0, 7);
  }

  /**
   * @param {object} rec
   * {
   *   requestId, ts, model, requestedModel, group, channelId, channelName,
   *   status, ok, latencyMs, stream, promptTokens, completionTokens, costUSD,
   *   cacheHit, attempts, error, clientKey
   * }
   */
  record(rec) {
    const day = this.dayKey();
    const month = this.monthKey();

    mergeStat(this.today, rec);
    mergeStat(this.month, rec);

    this.byGroup[rec.group] = this.byGroup[rec.group] || blankStat();
    mergeStat(this.byGroup[rec.group], rec);

    this.byModel[rec.model] = this.byModel[rec.model] || blankStat();
    mergeStat(this.byModel[rec.model], rec);

    this.byDay[day] = this.byDay[day] || blankStat();
    mergeStat(this.byDay[day], rec);

    this.logs.unshift(rec);
    if (this.logs.length > LOG_BUFFER_MAX) this.logs.length = LOG_BUFFER_MAX;

    this._pending.push(rec);
    if (this._pending.length >= 50) this.flush();
  }

  /** 组在某段时间的累计成本（用于预算熔断） */
  groupCostToday(group) {
    const s = this.byDay[this.dayKey()];
    return s ? s.byGroupCost[group] || 0 : 0;
  }
  groupCostMonth(group) {
    let total = 0;
    const mk = this.monthKey();
    for (const [day, s] of Object.entries(this.byDay)) {
      if (day.startsWith(mk)) total += s.byGroupCost[group] || 0;
    }
    return total;
  }

  /** 令牌维度的成本统计（用于 per-token 预算） */
  tokenCost(tokenName, scope) {
    const key = scope === 'month' ? this.monthKey() : this.dayKey();
    this._tokenCost = this._tokenCost || {};
    this._tokenCost[tokenName] = this._tokenCost[tokenName] || {};
    return this._tokenCost[tokenName][key] || 0;
  }
  addTokenCost(tokenName, usd) {
    if (!tokenName) return;
    const key = this.dayKey();
    this._tokenCost = this._tokenCost || {};
    this._tokenCost[tokenName] = this._tokenCost[tokenName] || {};
    this._tokenCost[tokenName][key] = (this._tokenCost[tokenName][key] || 0) + usd;
  }

  flush() {
    if (!this._pending.length) return;
    const batch = this._pending;
    this._pending = [];
    const file = path.join(this.dataDir, `usage-${this.dayKey()}.jsonl`);
    const text = batch.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFile(file, text, (err) => {
      if (err) console.error('[usage] 落盘失败:', err.message);
    });
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this.flush();
  }

  _restoreToday() {
    const file = path.join(this.dataDir, `usage-${this.dayKey()}.jsonl`);
    this._loadFile(file, (rec) => {
      mergeStat(this.today, rec);
      this.byGroup[rec.group] = this.byGroup[rec.group] || blankStat();
      mergeStat(this.byGroup[rec.group], rec);
      this.byModel[rec.model] = this.byModel[rec.model] || blankStat();
      mergeStat(this.byModel[rec.model], rec);
      this.byDay[this.dayKey()] = this.byDay[this.dayKey()] || blankStat();
      mergeStat(this.byDay[this.dayKey()], rec);
      this.logs.unshift(rec);
    });
    this.logs.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    if (this.logs.length > LOG_BUFFER_MAX) this.logs.length = LOG_BUFFER_MAX;
  }

  _restoreMonth() {
    const mk = this.monthKey();
    if (!fs.existsSync(this.dataDir)) return;
    for (const f of fs.readdirSync(this.dataDir)) {
      if (!/^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      const day = f.slice(6, 16);
      if (!day.startsWith(mk)) continue;
      if (day === this.dayKey()) continue; // 今天已在 _restoreToday 处理
      this._loadFile(path.join(this.dataDir, f), (rec) => {
        mergeStat(this.month, rec);
        this.byDay[day] = this.byDay[day] || blankStat();
        mergeStat(this.byDay[day], rec);
      });
    }
    // 今天的数据并入本月
    mergeStatInto(this.month, this.today);
  }

  _loadFile(file, fn) {
    if (!fs.existsSync(file)) return;
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          fn(JSON.parse(line));
        } catch (_) {
          /* 跳过损坏行 */
        }
      }
    } catch (e) {
      console.error('[usage] 读取历史失败:', e.message);
    }
  }

  snapshot() {
    return {
      today: Object.assign({}, this.today),
      month: Object.assign({}, this.month),
      byGroup: this.byGroup,
      byModel: topN(this.byModel, 20, 'costUSD'),
    };
  }
}

function blankStat() {
  return {
    requests: 0,
    success: 0,
    failed: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUSD: 0,
    latencySumMs: 0,
    byGroupCost: {},
  };
}

function mergeStat(s, rec) {
  s.requests += 1;
  if (rec.ok) s.success += 1;
  else s.failed += 1;
  s.promptTokens += rec.promptTokens || 0;
  s.completionTokens += rec.completionTokens || 0;
  s.costUSD += rec.costUSD || 0;
  s.latencySumMs += rec.latencyMs || 0;
  if (rec.group) s.byGroupCost[rec.group] = (s.byGroupCost[rec.group] || 0) + (rec.costUSD || 0);
}

function mergeStatInto(target, src) {
  target.requests += src.requests;
  target.success += src.success;
  target.failed += src.failed;
  target.promptTokens += src.promptTokens;
  target.completionTokens += src.completionTokens;
  target.costUSD += src.costUSD;
  target.latencySumMs += src.latencySumMs;
  for (const [g, v] of Object.entries(src.byGroupCost || {})) {
    target.byGroupCost[g] = (target.byGroupCost[g] || 0) + v;
  }
}

function topN(obj, n, sortKey) {
  const arr = Object.entries(obj).map(([k, v]) => Object.assign({ model: k }, v));
  arr.sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
  return arr.slice(0, n);
}

module.exports = { Usage };
