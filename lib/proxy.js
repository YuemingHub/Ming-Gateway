'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

/**
 * 反向代理核心
 *
 * 性能红线（对应「网关引入后不改变原有 API 的速率与性能」）：
 *   1. 流式响应零缓冲 —— 上游 chunk 到达即写回客户端，绝不攒包
 *   2. 请求体默认原样转发 —— 不需要改 model 时不做 parse/stringify
 *   3. 连接复用 —— 全局 keepAlive Agent
 *   4. 不重新压缩 —— 请求上游时不声明 accept-encoding，明文传输省一次 gzip
 */

const agents = {
  http: new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30000 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30000 }),
};

/** 按 provider 生成鉴权头 */
function authHeaders(channel) {
  const h = {};
  const key = channel.apiKey || '';
  switch (channel.provider) {
    case 'anthropic':
      h['x-api-key'] = key;
      h['anthropic-version'] = channel.headers && channel.headers['anthropic-version'] ? channel.headers['anthropic-version'] : '2023-06-01';
      break;
    case 'gemini':
    case 'google':
      h['x-goog-api-key'] = key;
      break;
    case 'cohere':
      h['Authorization'] = 'Bearer ' + key;
      break;
    default:
      h['Authorization'] = 'Bearer ' + key;
  }
  Object.assign(h, channel.headers || {});
  // 鉴权头不允许被 headers 覆盖成空
  if (!key) {
    delete h['Authorization'];
    delete h['x-api-key'];
    delete h['x-goog-api-key'];
  }
  return h;
}

/**
 * 转发请求
 *
 * @param {object} o
 *   channel  渠道配置
 *   url      完整上游 URL
 *   method   HTTP 方法
 *   headers  客户端请求头（已清洗）
 *   body     请求体 Buffer 或 null
 *   res      客户端响应对象（流式时直接写入）
 *   timeoutMs
 *   stream   是否按流式处理
 * @returns {Promise<{status, headers, body, usage, bytes, error}>}
 */
function forward(o) {
  const { channel, url, method, headers, body, res, timeoutMs, stream } = o;

  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(new Error('上游 URL 非法: ' + url));
      return;
    }

    const isHttps = u.protocol === 'https:';
    const outHeaders = Object.assign({}, headers);
    // 清洗必须重写的头
    // 必须删掉逐跳首部与长度/编码类首部：
    // 尤其 transfer-encoding —— 若把客户端的 chunked 透传出去、同时又设置 content-length，
    // 上游会直接判定请求畸形并返回 400。
    for (const k of Object.keys(outHeaders)) {
      const lk = k.toLowerCase();
      if (
        lk === 'host' ||
        lk === 'content-length' ||
        lk === 'connection' ||
        lk === 'transfer-encoding' ||
        lk === 'expect' ||
        lk === 'authorization' ||
        lk === 'x-api-key' ||
        lk === 'x-goog-api-key' ||
        lk === 'accept-encoding'
      ) {
        delete outHeaders[k];
      }
    }
    Object.assign(outHeaders, authHeaders(channel));
    if (body && body.length) outHeaders['content-length'] = String(body.length);
    if (body && body.length && !outHeaders['content-type']) outHeaders['content-type'] = 'application/json';

    const started = Date.now();

    // ---- 超时与中断的统一收口 ----
    // req.setTimeout 只是「空闲超时」：上游只要持续吐字节（哪怕拖一小时）都不会触发，
    // requestTimeoutMs 就形同虚设。所以必须自己按 deadline 掐断整体耗时。
    let settled = false;
    let req = null;
    const deadlineMs = timeoutMs || 300000;
    const deadline = setTimeout(() => {
      if (settled) return;
      // 注意：这里不能先置 settled=true。
      // 掐断之后还要靠 req 的 'error' 事件走进 rejectDone 完成结算；
      // 提前标记成已结算，那个 error 会被当成重复结算丢掉，Promise 就永远不落地 ——
      // 表现是「上游明明超时了，客户端却一直挂着等到自己的超时」。
      const e = new Error(`上游请求整体超时（${deadlineMs}ms 内未完成）`);
      e.code = 'UPSTREAM_TIMEOUT';
      try {
        req.destroy(e);
      } catch (_) {
        rejectDone(e);
      }
    }, deadlineMs);

    let abortHandler = null;
    function detach() {
      clearTimeout(deadline);
      if (abortHandler && res && typeof res.removeListener === 'function') res.removeListener('close', abortHandler);
    }
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      detach();
      fn(v);
    };
    const resolveDone = (v) => done(resolve, v);
    const rejectDone = (e) => done(reject, e);

    // 客户端断开：立刻掐掉上游，别让它在后台继续跑完再往一个死连接上写
    if (res && typeof res.on === 'function') {
      abortHandler = () => {
        if (settled) return;
        if (res.writableEnded || res.destroyed) return;
        settled = true;
        detach();
        try {
          req.destroy(new Error('客户端已断开连接'));
        } catch (_) {}
        reject(new Error('客户端已断开连接'));
      };
      res.on('close', abortHandler);
    }

    req = (isHttps ? https : http).request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: method || 'POST',
        headers: outHeaders,
        agent: isHttps ? agents.https : agents.http,
        timeout: timeoutMs || 300000,
      },
      (upstream) => {
        const respHeaders = {};
        for (const [k, v] of Object.entries(upstream.headers)) {
          const lk = k.toLowerCase();
          if (lk === 'transfer-encoding' || lk === 'connection' || lk === 'content-length') continue;
          respHeaders[k] = v;
        }

        // 只有成功响应才走流式透传。
        // 上游返回 4xx/5xx 时若也当流写出去，响应头就发出去了，网关将无法换渠道重试 ——
        // 错误响应一律按普通响应收集，把重试的决定权交回调用方。
        const isStream = (stream || /text\/event-stream/i.test(upstream.headers['content-type'] || '')) && upstream.statusCode < 400;

        if (isStream && res) {
          // ---- 流式：零缓冲透传，顺路抽 usage ----
          if (!res.headersSent) {
            res.writeHead(upstream.statusCode, Object.assign({}, respHeaders, { 'X-GW-Channel': channel.id, 'X-GW-Stream': '1' }));
          }
          let bytes = 0;
          let sseBuf = '';
          let usage = null;
          let firstChunkAt = 0;

          upstream.on('data', (chunk) => {
            if (!firstChunkAt) {
              firstChunkAt = Date.now();
              // 已经向客户端吐出第一个字节：此后任何失败都不能再重试
              // （响应头已发出，重试会导致 writeHead 抛 ERR_HTTP_HEADERS_SENT）
              if (typeof o.onFirstByte === 'function') o.onFirstByte();
            }
            // 先写给客户端，保证首字延迟不受任何处理影响
            try {
              res.write(chunk);
            } catch (e) {
              try {
                upstream.destroy();
              } catch (_) {}
              return;
            }
            bytes += chunk.length;

            // 再解析 usage（纯内存操作，不阻塞写回）
            if (!usage) {
              sseBuf += chunk.toString('utf8');
              let idx;
              while ((idx = sseBuf.indexOf('\n')) >= 0) {
                const line = sseBuf.slice(0, idx).trim();
                sseBuf = sseBuf.slice(idx + 1);
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                try {
                  const obj = JSON.parse(payload);
                  if (obj && obj.usage) usage = normalizeUsage(obj.usage);
                } catch (_) {}
              }
              if (sseBuf.length > 65536) sseBuf = sseBuf.slice(-8192);
            }
          });

          upstream.on('end', () => {
            try {
              res.end();
            } catch (_) {}
            resolveDone({
              status: upstream.statusCode,
              headers: respHeaders,
              body: null,
              usage,
              bytes,
              streamed: firstChunkAt > 0,
              ttfbMs: firstChunkAt ? firstChunkAt - started : Date.now() - started,
            });
          });

          upstream.on('error', (err) => {
            try {
              res.end();
            } catch (_) {}
            rejectDone(err);
          });
          return;
        }

        // ---- 非流式：收集完整响应 ----
        const chunks = [];
        upstream.on('data', (c) => chunks.push(c));
        upstream.on('end', () => {
          let buf = Buffer.concat(chunks);
          if (/gzip/i.test(upstream.headers['content-encoding'] || '')) {
            try {
              buf = zlib.gunzipSync(buf);
            } catch (_) {}
          } else if (/deflate/i.test(upstream.headers['content-encoding'] || '')) {
            try {
              buf = zlib.inflateSync(buf);
            } catch (_) {}
          }

          let usage = null;
          let text = null;
          try {
            text = buf.toString('utf8');
            const obj = JSON.parse(text);
            if (obj && obj.usage) usage = normalizeUsage(obj.usage);
          } catch (_) {}

          // 非流式响应默认不在这里写回 —— 由调用方决定是否写。
          // 因为上游返回 5xx 时网关还要换渠道重试，一旦这里提前写出，重试就失去意义。
          if (o.writeResponse && res && !res.writableEnded) {
            try {
              res.writeHead(upstream.statusCode, Object.assign({}, respHeaders, { 'X-GW-Channel': channel.id }));
              res.end(buf);
            } catch (_) {}
          }

          resolveDone({
            status: upstream.statusCode,
            headers: respHeaders,
            body: buf,
            text,
            usage,
            bytes: buf.length,
            ttfbMs: Date.now() - started,
          });
        });
        upstream.on('error', (e) => rejectDone(e));
      }
    );

    // 空闲超时（建连卡住、上游半天不吐一个字节）—— 与上面的整体 deadline 互补
    req.setTimeout(deadlineMs, () => {
      const e = new Error('上游连接空闲超时');
      e.code = 'UPSTREAM_TIMEOUT';
      req.destroy(e);
    });

    req.on('error', (e) => rejectDone(e));

    if (body && body.length) req.write(body);
    req.end();
  });
}

function normalizeUsage(u) {
  if (!u) return null;
  return {
    promptTokens: u.prompt_tokens || u.input_tokens || u.promptTokens || 0,
    completionTokens: u.completion_tokens || u.output_tokens || u.completionTokens || 0,
    cachedTokens:
      (u.prompt_tokens_details && (u.prompt_tokens_details.cached_tokens || u.prompt_tokens_details.cachedTokens)) ||
      u.cached_tokens ||
      u.cache_read_input_tokens ||
      0,
  };
}

module.exports = { forward, authHeaders, agents };
