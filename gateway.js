#!/usr/bin/env node
'use strict';

/**
 * 统一 API 网关 —— 入口
 *
 * 零依赖、单进程、内存态。启动只需：node gateway.js
 *
 * 用法：
 *   node gateway.js                          使用 ./gateway.yaml
 *   node gateway.js --config ./my.yaml
 *   node gateway.js --port 9000 --host 0.0.0.0
 *   node gateway.js --check                  只校验配置，不启动
 */

const path = require('path');
const fs = require('fs');
const { load, validateChannelList } = require('./lib/config');
const { ChannelStore } = require('./lib/store');
const { GatewayServer, VERSION } = require('./lib/server');

/**
 * 组装最终生效的配置
 *
 * 渠道有两个来源，优先级：data/channels.json（状态页维护）> gateway.yaml（手写基线）
 *   - 页面从未保存过 → 完全用 YAML 的 channels
 *   - 页面保存过 → data/channels.json 整体接管渠道，YAML 继续提供
 *     server / groups / tokens / routes 这些「策略」配置
 */
function buildConfig(configPath) {
  const config = load(configPath, { allowEmptyChannels: true });
  const store = new ChannelStore(config.server.dataDir);

  if (store.exists()) {
    const stored = store.list();
    if (stored && stored.length) {
      const v = validateChannelList(stored, config);
      if (v.errors.length) {
        console.error('[渠道库有误] data/channels.json 校验未通过，本次回退到 gateway.yaml 的渠道：');
        for (const e of v.errors) console.error('  - ' + e);
      } else {
        config.channels = v.channels;
        config.__channelSource = 'store';
      }
    }
  }

  if (config.channels.length === 0) {
    throw new Error(
      '没有任何可用渠道：gateway.yaml 的 channels 为空，且 data/channels.json 不存在或不合法。\n' +
        '  请先在 gateway.yaml 里配置至少一个渠道作为基线。'
    );
  }
  if (config.channels.filter((c) => c.enabled).length === 0) {
    throw new Error('所有渠道都是 enabled: false，网关无法工作。请至少启用一个渠道。');
  }
  return config;
}

function parseArgs(argv) {
  const out = { config: null, port: null, host: null, check: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') out.config = argv[++i];
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--host' || a === '-H') out.host = argv[++i];
    else if (a === '--check') out.check = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(`统一 API 网关 v${VERSION}
用法：node gateway.js [选项]
  -c, --config <file>   配置文件路径（默认 ./gateway.yaml）
  -p, --port <n>        覆盖监听端口
  -H, --host <addr>     覆盖监听地址
      --check           只校验配置是否正确
  -h, --help            显示帮助`);
    return;
  }

  const configPath = args.config
    ? path.resolve(args.config)
    : path.join(__dirname, process.env.GATEWAY_CONFIG || 'gateway.yaml');

  let config;
  try {
    config = buildConfig(configPath);
  } catch (e) {
    console.error('\n[配置错误] ' + e.message + '\n');
    process.exit(1);
  }

  if (args.port) config.server.port = args.port;
  if (args.host) config.server.host = args.host;

  const fromStore = config.__channelSource === 'store';

  // 渠道写的是 ${ENV_VAR}，但环境里没这个值 —— 展开后为空，运行时会一律被上游 401。
  // 这种「配了却不通」最难排查，所以启动时就把话说清楚。
  const unresolved = config.channels.filter((c) => c.keyRef && !c.apiKey);
  if (unresolved.length) {
    console.warn('\n[警告] 这些渠道的密钥引用了环境变量，但没读到值，运行时会被上游拒绝：');
    for (const c of unresolved) console.warn(`  - ${c.id}  ←  ${c.keyRef}`);
    console.warn(`  请检查 ${path.dirname(configPath)} 下的 .env 是否填好了对应的变量。\n`);
  }

  if (args.check) {
    console.log(`配置校验通过：${configPath}`);
    console.log(`  分组：${Object.keys(config.groups).join(', ')}`);
    console.log(`  渠道来源：${fromStore ? 'data/channels.json（状态页维护）' : 'gateway.yaml'}`);
    console.log(`  渠道：${config.channels.length} 个（启用 ${config.channels.filter((c) => c.enabled).length} 个）`);
    for (const [k, g] of Object.entries(config.groups)) {
      const n = config.channels.filter((c) => c.group === k).length;
      console.log(`    ${k} ${g.name}：${n} 个渠道`);
    }
    console.log(`  令牌：${config.tokens.length} 个`);
    if (config.server.auth && config.server.auth.enabled) {
      console.log(`  登录：已开启（用户名 ${config.server.auth.username}，会话 ${config.server.auth.sessionTtlSec}s）`);
    }
    return;
  }

  const server = new GatewayServer(config);

  server.start().then((addr) => {
    const port = typeof addr === 'object' ? addr.port : config.server.port;
    console.log('');
    console.log(`  统一 API 网关 v${VERSION} 已启动`);
    console.log(`  监听      http://${config.server.host}:${port}`);
    console.log(`  配置文件  ${configPath}`);
    console.log(`  状态页    http://127.0.0.1:${port}/__gw/`);
    console.log(
      `  渠道      ${config.channels.length} 个（启用 ${config.channels.filter((c) => c.enabled).length}）` +
        `  [来源：${fromStore ? 'data/channels.json' : 'gateway.yaml'}]`
    );
    console.log(`  降级链    ${config.fallback.chain.join(' → ')}   （C 组需显式指定）`);
    console.log(
      `  客户端鉴权 ${config.tokens.length ? '已开启（' + config.tokens.length + ' 个令牌，需带 Authorization: Bearer）' : '未开启 —— 任何能访问该端口的人都可直接调用'}` +
        (config.tokens.length ? '' : '  ⚠️')
    );
    if (config.server.auth && config.server.auth.enabled) {
      console.log(`  管理面登录 已开启（用户名 ${config.server.auth.username}）`);
    } else if (config.server.adminToken) {
      console.log('  管理面鉴权 已开启（X-Admin-Token）');
    } else {
      console.log('  管理面登录 未开启 —— 仅本机可访问管理接口');
    }
    console.log('');
  });

  const shutdown = (sig) => {
    console.log(`\n收到 ${sig}，正在优雅退出...`);
    try {
      server.stop();
    } catch (_) {}
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    console.error('[未捕获异常]', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[未处理的 Promise 拒绝]', err);
  });
}

main();
