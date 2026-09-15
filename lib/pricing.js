'use strict';

/**
 * 模型价格表与成本计算
 *
 * 单位统一为「USD / 每 100 万 token」。
 * 表中数值为 2026-09 前后的公开参考价，厂商随时调价，
 * 请务必在 gateway.yaml 的 pricing 段用实际账单价覆盖。
 *
 * 字段：
 *   in      输入（prompt）价格
 *   out     输出（completion）价格
 *   cache   命中 prompt 缓存时的输入价格（没有则按 in 计）
 */

const BUILTIN = {
  // ---- OpenAI ----
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1': { in: 2.0, out: 8.0 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1-nano': { in: 0.1, out: 0.4 },
  'o1': { in: 15.0, out: 60.0, cache: 7.5 },
  'o1-mini': { in: 1.1, out: 4.4, cache: 0.55 },
  'o3': { in: 2.0, out: 8.0, cache: 0.5 },
  'o3-mini': { in: 1.1, out: 4.4, cache: 0.55 },
  'gpt-4-turbo': { in: 10.0, out: 30.0 },
  'text-embedding-3-small': { in: 0.02, out: 0 },
  'text-embedding-3-large': { in: 0.13, out: 0 },

  // ---- Anthropic ----
  'claude-opus-4': { in: 15.0, out: 75.0, cache: 1.5 },
  'claude-opus-4-1': { in: 15.0, out: 75.0, cache: 1.5 },
  'claude-sonnet-4': { in: 3.0, out: 15.0, cache: 0.3 },
  'claude-sonnet-4-5': { in: 3.0, out: 15.0, cache: 0.3 },
  'claude-3-7-sonnet': { in: 3.0, out: 15.0, cache: 0.3 },
  'claude-3-5-sonnet': { in: 3.0, out: 15.0, cache: 0.3 },
  'claude-3-5-haiku': { in: 0.8, out: 4.0, cache: 0.08 },
  'claude-3-haiku': { in: 0.25, out: 1.25 },

  // ---- Google ----
  'gemini-2.5-pro': { in: 1.25, out: 10.0 },
  'gemini-2.5-flash': { in: 0.15, out: 0.6 },
  'gemini-2.0-flash': { in: 0.1, out: 0.4 },
  'gemini-1.5-pro': { in: 1.25, out: 5.0 },
  'gemini-1.5-flash': { in: 0.075, out: 0.3 },

  // ---- DeepSeek ----
  'deepseek-chat': { in: 0.27, out: 1.1, cache: 0.07 },
  'deepseek-reasoner': { in: 0.55, out: 2.19, cache: 0.14 },
  'deepseek-v3': { in: 0.27, out: 1.1 },
  'deepseek-r1': { in: 0.55, out: 2.19 },

  // ---- 智谱 GLM ----
  'glm-4.6': { in: 0.6, out: 1.8 },
  'glm-4.5': { in: 0.6, out: 1.8 },
  'glm-4.5-air': { in: 0.2, out: 1.0 },
  'glm-4-plus': { in: 1.4, out: 1.4 },
  'glm-4-air': { in: 0.14, out: 0.14 },
  'glm-4-flash': { in: 0.0, out: 0.0 },

  // ---- 通义千问 ----
  'qwen-max': { in: 1.6, out: 6.4 },
  'qwen-plus': { in: 0.4, out: 1.2 },
  'qwen-turbo': { in: 0.05, out: 0.2 },
  'qwen2.5-72b-instruct': { in: 0.4, out: 1.2 },
  'qwen3-235b-a22b': { in: 0.35, out: 1.4 },
  'qwen3-32b': { in: 0.1, out: 0.3 },

  // ---- 月之暗面 Kimi ----
  'moonshot-v1-8k': { in: 1.7, out: 1.7 },
  'moonshot-v1-32k': { in: 1.7, out: 1.7 },
  'moonshot-v1-128k': { in: 1.7, out: 1.7 },
  'kimi-k2': { in: 0.6, out: 2.5 },

  // ---- 字节豆包 ----
  'doubao-pro-32k': { in: 0.12, out: 0.12 },
  'doubao-pro-128k': { in: 0.7, out: 0.7 },
  'doubao-lite-32k': { in: 0.04, out: 0.04 },
  'doubao-seed-1-6': { in: 0.12, out: 1.2 },

  // ---- MiniMax ----
  'minimax-text-01': { in: 0.2, out: 1.1 },
  'MiniMax-Text-01': { in: 0.2, out: 1.1 },

  // ---- 免费 / 本地 ----
  'ollama': { in: 0, out: 0 },
  'local': { in: 0, out: 0 },
};

/** 免费或本地模型名特征：命中即按 0 成本计 */
const FREE_HINTS = [':free', 'free', 'local', 'ollama', 'cloudflare'];

class Pricer {
  /**
   * @param {object} overrides 来自 gateway.yaml 的 pricing 覆盖，键为模型名
   */
  constructor(overrides) {
    this.table = Object.assign({}, BUILTIN);
    if (overrides && typeof overrides === 'object') {
      for (const [k, v] of Object.entries(overrides)) {
        if (v && typeof v === 'object') {
          this.table[k] = { in: num(v.in, 0), out: num(v.out, 0), cache: v.cache != null ? num(v.cache, 0) : undefined };
        } else if (typeof v === 'number') {
          this.table[k] = { in: v, out: v };
        }
      }
    }
  }

  /** 取价格，未登记的模型按 0 计并在调用方标注 unknown */
  get(model) {
    if (!model) return { in: 0, out: 0, known: false };
    if (this.table[model]) return Object.assign({ known: true }, this.table[model]);

    const lower = String(model).toLowerCase();
    if (FREE_HINTS.some((h) => lower.includes(h))) return { in: 0, out: 0, known: true };

    // 去厂商前缀再试一次：如 siliconflow/deepseek-ai/DeepSeek-V3
    const short = lower.replace(/^[^/]+\//, '');
    if (this.table[short]) return Object.assign({ known: true }, this.table[short]);
    for (const key of Object.keys(this.table)) {
      if (short.includes(key)) return Object.assign({ known: true }, this.table[key]);
    }
    return { in: 0, out: 0, known: false };
  }

  /**
   * 计算一次请求的成本（USD）
   * @param {string} model
   * @param {object} usage {promptTokens, completionTokens, cachedTokens}
   */
  cost(model, usage) {
    const p = this.get(model);
    const u = usage || {};
    const pIn = Math.max(0, num(u.promptTokens, 0));
    const pOut = Math.max(0, num(u.completionTokens, 0));
    const cached = Math.min(pIn, Math.max(0, num(u.cachedTokens, 0)));
    const billableIn = pIn - cached;
    const inRate = cached > 0 && p.cache != null ? p.cache : p.in;
    const usd = (billableIn / 1e6) * inRate + (cached / 1e6) * inRate + (pOut / 1e6) * p.out;
    return { costUSD: round6(usd), known: p.known, rate: p };
  }
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

module.exports = { Pricer, BUILTIN };
