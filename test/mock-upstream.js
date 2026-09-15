'use strict';

/**
 * Mock 上游：模拟 OpenAI 兼容的大模型 API，用于端到端测试网关
 * 支持三种模式：ok（正常）/ fail（500）/ slow（延迟）
 *
 * opts.models：GET /models 返回的模型清单。传 null 表示该上游不提供 /models（返回 404），
 *              用于测试「获取模型列表」失败时的回退路径。
 */

const http = require('http');

const DEFAULT_MODELS = ['deepseek-chat', 'deepseek-reasoner', 'glm-4.6'];

function startMock(port, opts) {
  const o = Object.assign(
    {
      channelId: 'mock-' + port,
      mode: 'ok',
      delayMs: 0,
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      models: DEFAULT_MODELS,
      modelsShape: 'openai', // openai | gemini | ollama —— 测试不同的 /models 响应形状
      hangMs: 0, // >0 表示故意挂着不返回，用于测试探测超时
      // 让 /chat/completions 直接返回指定状态码（如 404「没有这个模型」、401「Key 失效」），
      // 用来验证「某个渠道模型不通时能不能轮换到下一个渠道」。/models 不受影响。
      chatStatus: 0,
      // 复刻 OpenCode Go 的行为：缺少指定请求头就 400 拒绝。
      // 用来验证「渠道里配的自定义 headers 有没有真的转发到上游」。
      // 形如 { name: 'x-opencode-session', value: 'abc' }（value 省略则只校验存在性）
      requireHeader: null,
    },
    opts || {}
  );

  const server = http.createServer((req, res) => {
    // 故意挂起：不返回任何响应，直到 hangMs 后直接断开。
    // 用来验证「探测超时后不再发起第二次慢请求」——这是用户看到「一直转圈」的根因。
    if (o.hangMs > 0) {
      req.resume();
      setTimeout(() => {
        try {
          res.destroy();
        } catch (_) {}
      }, o.hangMs);
      return;
    }

    if (o.requireHeader && o.requireHeader.name) {
      const got = req.headers[String(o.requireHeader.name).toLowerCase()];
      const bad = !got || (o.requireHeader.value != null && got !== o.requireHeader.value);
      if (bad) {
        req.resume();
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            error: { message: `mock upstream requires header ${o.requireHeader.name}`, type: 'invalid_request_error' },
          })
        );
      }
    }

    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const done = () => {
        if (o.mode === 'fail') {
          res.writeHead(500, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'mock upstream exploded', type: 'server_error' } }));
        }
        if (o.mode === 'rate') {
          res.writeHead(429, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'mock rate limit', type: 'rate_limit' } }));
        }

        const urlPath = (req.url || '').split('?')[0];

        // ---- GET /models：模型清单 ----
        if (req.method === 'GET' && /\/models\/?$/.test(urlPath)) {
          if (!o.models) {
            res.writeHead(404, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'mock upstream has no /models endpoint', type: 'not_found' } }));
          }
          if (o.mode === 'unauthorized') {
            res.writeHead(401, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error' } }));
          }
          let payload;
          if (o.modelsShape === 'gemini') {
            payload = { models: o.models.map((m) => ({ name: 'models/' + m, displayName: m })) };
          } else if (o.modelsShape === 'ollama') {
            payload = { models: o.models.map((m) => ({ name: m, size: 123 })) };
          } else {
            payload = { object: 'list', data: o.models.map((m) => ({ id: m, object: 'model', owned_by: o.channelId })) };
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify(payload));
        }

        // 模拟「这个渠道没有这个模型 / Key 失效」：直接以指定状态码拒绝对话请求
        if (o.chatStatus) {
          res.writeHead(o.chatStatus, { 'content-type': 'application/json' });
          return res.end(
            JSON.stringify({
              error: { message: `mock upstream rejected with ${o.chatStatus}`, type: 'mock_error' },
            })
          );
        }

        let parsed = {};
        try {
          parsed = JSON.parse(body || '{}');
        } catch (_) {}

        const isStream = !!parsed.stream;
        const content = `MOCK:${o.channelId}`;

        if (isStream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          const chunks = ['你好', '，这是', '流式', '响应'];
          let i = 0;
          const timer = setInterval(() => {
            if (i < chunks.length) {
              const delta = chunks[i++];
              res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`);
            } else {
              clearInterval(timer);
              if (parsed.stream_options && parsed.stream_options.include_usage) {
                res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: o.usage.prompt_tokens, completion_tokens: o.usage.completion_tokens } })}\n\n`);
              }
              res.write('data: [DONE]\n\n');
              res.end();
            }
          }, 15);
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: parsed.model || 'mock',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: o.usage.prompt_tokens, completion_tokens: o.usage.completion_tokens },
          })
        );
      };

      if (o.delayMs > 0) setTimeout(done, o.delayMs);
      else done();
    });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { startMock };
