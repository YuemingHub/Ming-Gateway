'use strict';

/**
 * 分组路由与渠道选择
 *
 * 核心规则：
 *   1. C 组（requireExplicit）只能通过显式指定进入，永不因降级被动进入 —— 防止一次误调用烧掉预算
 *   2. 组内严格按 channel.order 升序消耗（order = 状态页里从上往下的位置，由 config 归一化成稠密序号）：
 *      第一路健康就一直用它，只有它失败 / 冷却 / 限流时才依次落到下一路。
 *      不再按 weight 加权随机打散 —— 顺序就是顺序，看得见、可预期。
 *   3. 候选渠道必须在「启用 + 未冷却 + 支持该模型 + 限流通过」四个条件下才进入候选池
 */

class Router {
  /**
   * @param {object} config
   * @param {import('./health').HealthRegistry} health
   * @param {import('./limiter').Limiter} limiter
   */
  constructor(config, health, limiter) {
    this.config = config;
    this.health = health;
    this.limiter = limiter;
    // 是否允许一次请求跨组轮换。false = 严格按组隔离：
    // 选了 B 就只在 B 的渠道里轮换，即使 B 全挂也不会跑到 A/C。
    this.crossGroup = config.fallback && config.fallback.crossGroup === false ? false : true;

    this.byId = new Map();
    // id → 在 config.channels 里的下标：给排序做稳定的兜底比较键
    this.indexById = new Map();
    config.channels.forEach((c, i) => this.indexById.set(c.id, i));
    for (const c of config.channels) {
      this.byId.set(c.id, c);
      // 让 health 记录渠道所属分组，便于按组统计
      const h = health.get(c.id);
      if (h) h.groupKey = c.group;
    }
  }

  /**
   * 决定本次请求要走哪些组（有序）
   * @param {string} model
   * @param {string|null} explicitGroup 来自 header X-GW-Group 或 model 前缀 "c:xxx"
   * @param {string[]} allowGroups 令牌允许的组
   * @returns {string[]}
   */
  resolveGroups(model, explicitGroup, allowGroups) {
    const cfg = this.config;
    const allowed = (g) => !!cfg.groups[g] && (!allowGroups || allowGroups.includes(g));
    // crossGroup 关掉时一次请求只待在一个组里：组内轮换，绝不跨组
    const oneOrAll = (list) => (this.crossGroup ? list : list.slice(0, 1));

    if (explicitGroup) {
      const g = String(explicitGroup).toUpperCase();
      if (!cfg.groups[g]) return [];
      if (allowGroups && !allowGroups.includes(g)) return [];
      return [g];
    }

    // 令牌只授权了一个组 → 「用某个组的 key 就只用某个组」。
    // 这是按组隔离的主入口：B 组的 key 只走 B 组渠道，不会串到 A 或 C。
    if (allowGroups && allowGroups.length === 1 && allowed(allowGroups[0])) {
      return [allowGroups[0]];
    }

    // 显式路由表优先
    if (cfg.routes[model]) {
      const r = cfg.routes[model].filter(allowed);
      if (r.length) return oneOrAll(r);
    }

    // 默认走降级链（A → B），C 不在链里（requireExplicit 的组永不被动进入）
    const chain = (cfg.fallback.enabled ? cfg.fallback.chain.slice() : []).filter(allowed);
    if (chain.length) return oneOrAll(chain);

    // 兜底：令牌授权的第一个组。
    // 这里不再排除 requireExplicit —— 令牌显式授权了 C 就等于显式指定，
    // 否则「只授权 C 的令牌」会莫名 403。
    const first = Object.keys(cfg.groups).find(allowed);
    return first ? [first] : [];
  }

  /**
   * 在指定组里挑可用渠道，返回按优先级排好的候选队列
   * @param {string[]} groupKeys
   * @param {string} model
   * @param {number} estTokens
   * @param {object} tokenLimits 客户端令牌限流（叠加检查）
   * @returns {Array<{channel, reason?}>} 候选（已按优先顺序）
   */
  candidates(groupKeys, model, estTokens, tokenKey, tokenLimits) {
    const now = Date.now();
    const out = [];

    for (const gk of groupKeys) {
      const group = this.config.groups[gk];
      if (!group) continue;

      // 组级限流
      if (tokenLimits) {
        const gcheck = this.limiter.check(`group:${gk}`, group.limits, estTokens);
        if (!gcheck.ok) continue;
      }

      const pool = this.config.channels.filter(
        (c) => c.group === gk && c.enabled && this.health.get(c.id).isAvailable(now) && this.supportsModel(c, model)
      );
      if (pool.length === 0) continue;

      // 组内顺序 = 状态页里从上往下的位置（channel.order，0 起，已由 config 压成稠密序号）。
      // 早先是「priority 分层 + 层内加权随机」，会把流量主动打散到同层的多个渠道；
      // 现在改成确定性顺序：第一路健康就一直用它，它失败/冷却/限流时才往后落到下一路。
      // 注意仍要把「该组全部可用渠道」都放进候选池 —— 只取队首的话，
      // 一旦它失败就没有备选可重试，故障转移会失效。
      const ordered = pool.slice().sort((a, b) => {
        const ao = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
        const bo = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
        if (ao !== bo) return ao - bo;
        // order 相同（理论上归一化后不会出现）时，按配置里的出现先后定序，保证结果稳定
        const ai = this.indexById.has(a.id) ? this.indexById.get(a.id) : 0;
        const bi = this.indexById.has(b.id) ? this.indexById.get(b.id) : 0;
        return ai - bi;
      });

      for (const c of ordered) {
        const chk = this.limiter.check(`channel:${c.id}`, c.limits, estTokens);
        if (chk.ok) {
          out.push({ channel: c, group: gk, priority: c.priority });
        }
      }
    }

    return out;
  }

  supportsModel(channel, model) {
    if (!channel.models || channel.models.length === 0) return true;
    if (channel.models.includes(model)) return true;
    // 支持通配符：deepseek-* / glm-*
    return channel.models.some((m) => {
      if (!m.includes('*')) return false;
      const re = new RegExp('^' + m.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      return re.test(model);
    });
  }

  /** 上游实际模型名（应用 modelMap 映射） */
  upstreamModel(channel, model) {
    return channel.modelMap && channel.modelMap[model] ? channel.modelMap[model] : model;
  }

  /**
   * 上游 URL 拼接
   *
   * 网关对外统一暴露 /v1/*，而渠道 baseUrl 通常已经带版本号
   * （https://api.deepseek.com/v1、https://api.anthropic.com/v1 等），
   * 因此拼接前必须剥掉请求路径里的版本前缀，否则会拼成 /v1/v1/chat/completions。
   */
  buildUrl(channel, upstreamPath) {
    const base = channel.baseUrl.replace(/\/+$/, '');
    let p = String(upstreamPath || '').replace(/^\/+/, '');
    p = p.replace(/^v\d+[a-z0-9]*\//i, '');
    return base + '/' + p;
  }
}

module.exports = { Router };
