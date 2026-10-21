'use strict';

/**
 * 错误外送/落盘前的唯一安全投影。
 *
 * 上游错误正文和异常消息都可能回显 Authorization、API Key 或任意长凭据；
 * 调用方响应、usage JSONL、stdout/journal、管理日志与渠道健康快照都必须
 * 经过这里，不能各自决定怎么截断。
 */

const REDACTED = '[REDACTED]';

const SECRET_PATTERNS = [
  // OpenAI / Anthropic 风格密钥
  [/\bsk-[A-Za-z0-9_-]{4,}/g, `sk-${REDACTED}`],
  // Authorization 回显
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, `Bearer ${REDACTED}`],
  // 带标签的凭据：api_key=、token:、password=、authorization= ...
  [
    /\b(api[_-]?key|access[_-]?key|auth[_-]?key|token|secret|password|passwd|authorization)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{6,}/gi,
    `$1$2${REDACTED}`,
  ],
  // 没有标签的不透明长凭据：同时含大小写与数字的 24+ 字符串
  [/\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}\b/g, REDACTED],
];

/**
 * 压成单行并脱敏，再按上限截断。
 * 单行是硬要求：多行文本可以在日志里伪造出一条看似合法的记录。
 */
function redactSecrets(value, maxLen) {
  let s = String(value == null ? '' : value);
  for (const [re, replacement] of SECRET_PATTERNS) s = s.replace(re, replacement);
  s = s.replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const cap = maxLen || 300;
  return s.length > cap ? s.slice(0, cap) + '…' : s;
}

/** 上游 HTTP 错误在日志/JSONL/健康快照里的统一摘要（不含上游正文） */
function upstreamFailureSummary(status) {
  return `上游返回 HTTP ${Number(status) || 502}`;
}

/** 上游 HTTP 错误返回给调用方的稳定安全错误体 */
function safeUpstreamError(status) {
  const code = Number(status) || 502;
  return {
    error: {
      message: `上游服务返回 HTTP ${code}，上游详情已隐藏`,
      type: 'upstream_error',
      code: 'upstream_error',
    },
  };
}

/** 异常（catch 分支）的安全摘要：稳定类别 + 脱敏后的单行细节，不含堆栈 */
function thrownFailureSummary(err) {
  const code = String((err && err.code) || '');
  const name = String((err && err.name) || '');
  const message = String((err && err.message) || err || '');
  const hay = `${code} ${name} ${message}`;
  let category = '上游请求异常';
  if (/timeout|timedout|abort|超时/i.test(hay)) category = '上游请求超时';
  else if (/econn|enotfound|eai_again|enetunreach|epipe|socket|network|fetch failed|connection/i.test(hay)) {
    category = '上游连接失败';
  }
  const detail = redactSecrets(message, 160);
  return detail ? `${category}：${detail}` : category;
}

module.exports = {
  redactSecrets,
  upstreamFailureSummary,
  safeUpstreamError,
  thrownFailureSummary,
};
