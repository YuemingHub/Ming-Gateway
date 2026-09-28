'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 渠道库（页面可编辑的渠道真源）
 *
 * 为什么要单独一个文件，而不是回写 gateway.yaml？
 *   1. 我们只有 YAML 解析器、没有序列化器，回写会重排注释与缩进，把用户手写的配置搞乱；
 *   2. 渠道是「高频改」的数据，策略（分组/预算/令牌/降级链）是「低频改」的配置，分开更安全；
 *   3. 页面误操作时，删掉 data/channels.json 就能一键回到 YAML 基线。
 *
 * 优先级：data/channels.json（页面管理）> gateway.yaml（手写基线）
 *   - 该文件不存在 → 用 YAML 的 channels
 *   - 任何一次页面保存 → 以「当前生效的渠道全量」为种子写入该文件，此后以它为准
 *   - 文件里的 apiKey 保留 ${ENV_VAR} 原样，避免把环境变量里的密钥固化成明文
 */

const FILE_NAME = 'channels.json';
const GROUPS_FILE_NAME = 'groups.json';
const STORE_VERSION = 1;

class ChannelStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, FILE_NAME);
  }

  exists() {
    try {
      return fs.statSync(this.file).isFile();
    } catch (_) {
      return false;
    }
  }

  /** 读取原始文档；损坏时返回 null 并按 .bak 备份，避免彻底丢失 */
  read() {
    if (!this.exists()) return null;
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (_) {
      return null;
    }
    try {
      const doc = JSON.parse(text);
      if (!doc || !Array.isArray(doc.channels)) return null;
      return doc;
    } catch (e) {
      try {
        fs.copyFileSync(this.file, this.file + '.broken');
      } catch (_) {}
      console.error(`[store] ${this.file} 解析失败（已备份为 .broken），本次回退到 YAML 基线：${e.message}`);
      return null;
    }
  }

  list() {
    const doc = this.read();
    return doc ? doc.channels : null;
  }

  /** 原子写入：先写临时文件再 rename，避免写一半断电导致渠道全丢 */
  write(channels, extra) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const doc = Object.assign(
      {
        version: STORE_VERSION,
        updatedAt: new Date().toISOString(),
        count: channels.length,
        _note: '此文件由网关状态页维护（渠道增删改）。可安全删除以回退到 gateway.yaml 的 channels。',
        channels,
      },
      extra || {}
    );
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600); // 里面可能有明文 Key
    } catch (_) {}
    return doc;
  }

  remove() {
    if (!this.exists()) return false;
    try {
      fs.copyFileSync(this.file, this.file + '.bak');
    } catch (_) {}
    fs.unlinkSync(this.file);
    return true;
  }

  /** 供状态页显示：这份渠道是从哪来的 */
  info() {
    if (!this.exists()) return { source: 'yaml', file: null, updatedAt: null, count: 0 };
    const doc = this.read();
    return {
      source: doc ? 'store' : 'yaml',
      file: this.file,
      updatedAt: doc ? doc.updatedAt : null,
      count: doc ? doc.channels.length : 0,
    };
  }
}

// ---------------------------------------------------------------- 分组库

/**
 * 分组库（状态页自己新建的分组）
 *
 * 与渠道库同理，但只放「页面新增的组」，不放 gateway.yaml 里的 A/B/C ——
 * 内置组的策略（预算、限流、降级链）继续由 YAML 做真源，两边不会互相覆盖。
 *
 * 文件形状：{ version, updatedAt, groups: [{ key, name, desc, requireExplicit, token:{key} }] }
 *
 * ⚠️ 这里会写明文：自定义组的专属 KEY 就是给运营者自己复制用的。
 *    因此权限与渠道库一致（0600、data/ 已被 .gitignore 忽略）。
 */
class GroupStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, GROUPS_FILE_NAME);
  }

  exists() {
    try {
      return fs.statSync(this.file).isFile();
    } catch (_) {
      return false;
    }
  }

  /** 读取分组数组；文件缺失或损坏时返回 null（损坏会留 .broken 备份），调用方回退到「只有内置组」 */
  list() {
    if (!this.exists()) return null;
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (_) {
      return null;
    }
    try {
      const doc = JSON.parse(text);
      if (!doc || !Array.isArray(doc.groups)) return null;
      return doc.groups;
    } catch (e) {
      try {
        fs.copyFileSync(this.file, this.file + '.broken');
      } catch (_) {}
      console.error(`[store] ${this.file} 解析失败（已备份为 .broken），本次只使用 gateway.yaml 的分组：${e.message}`);
      return null;
    }
  }

  /** 原子写入：先写临时文件再 rename，避免写一半断电把分组整份丢掉 */
  write(groups) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const doc = {
      version: STORE_VERSION,
      updatedAt: new Date().toISOString(),
      count: groups.length,
      _note:
        '此文件由网关状态页维护（页面新建的分组及其专属 KEY）。内置组 A/B/C 不在此文件，仍以 gateway.yaml 为准。' +
        '删除本文件即移除所有自建分组。',
      groups,
    };
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600); // 里面有明文 KEY
    } catch (_) {}
    return doc;
  }

  info() {
    if (!this.exists()) return { source: 'yaml', file: null, count: 0 };
    const groups = this.list();
    return { source: groups ? 'store' : 'yaml', file: this.file, count: groups ? groups.length : 0 };
  }
}

/** 运行时分组对象 → 可落盘对象（只写页面会改的那几项） */
function toStoredGroup(g) {
  const out = {
    key: g.key,
    name: g.name,
    desc: g.desc || '',
    requireExplicit: !!g.requireExplicit,
    createdAt: g.createdAt || new Date().toISOString(),
  };
  if (g.token && g.token.key) out.token = { key: g.token.key, enabled: g.token.enabled !== false };
  return out;
}

// ---------------------------------------------------------------- 序列化

/**
 * 运行时渠道对象 → 可落盘对象
 * 关键点：apiKey 优先写回 keyRef（${ENV_VAR} 原始引用），只有本来就是明文时才写明文。
 */
function toStored(ch) {
  const out = {
    id: ch.id,
    name: ch.name,
    group: ch.group,
    provider: ch.provider,
    plan: ch.plan,
    baseUrl: ch.baseUrl,
    apiKey: ch.keyRef || ch.apiKey || '',
    weight: ch.weight,
    priority: ch.priority,
    order: ch.order,
    enabled: ch.enabled !== false,
  };
  if (ch.headers && Object.keys(ch.headers).length) out.headers = ch.headers;
  if (ch.models && ch.models.length) out.models = ch.models;
  if (ch.modelMap && Object.keys(ch.modelMap).length) out.modelMap = ch.modelMap;
  if (ch.timeoutMs) out.timeoutMs = ch.timeoutMs;
  if (ch.cooldown) out.cooldown = ch.cooldown;

  // 只写非零限流项，保持文件可读
  const lim = ch.limits || {};
  const limOut = {};
  for (const k of ['rpm', 'tpm', 'concurrency', 'windowSec', 'windowMaxRequests', 'windowMaxTokens']) {
    if (Number(lim[k]) > 0) limOut[k] = Number(lim[k]);
  }
  if (Object.keys(limOut).length) out.limits = limOut;
  return out;
}

/** 是否形如 ${VAR} 或 ${VAR:default} 的环境变量引用 */
function isEnvRef(v) {
  return typeof v === 'string' && /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::[^}]*)?\}$/.test(v.trim());
}

/**
 * 密钥掩码：用于回传给页面。
 * 绝不把明文 Key 发到浏览器 —— 留着只是为了让你确认「这个渠道到底配没配 Key」。
 */
function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (isEnvRef(k)) return k; // env 引用不是秘密，原样显示便于确认
  if (k.length <= 8) return k.slice(0, 2) + '****';
  return k.slice(0, 4) + '****' + k.slice(-4);
}

module.exports = {
  ChannelStore,
  GroupStore,
  toStored,
  toStoredGroup,
  isEnvRef,
  maskKey,
  FILE_NAME,
  GROUPS_FILE_NAME,
  STORE_VERSION,
};
