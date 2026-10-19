/**
 * Query parameters whose value is a credential or a request signature
 * (presigned S3/OSS links carry `X-Amz-Signature`, `Signature`, …).
 */
const SECRET_PARAMS =
  "key|api_key|apikey|api-key|token|access_token|refresh_token|id_token|auth|signature|sig|" +
  "x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|" +
  "client_secret|secret|password";
const SECRET_PARAM_RE = new RegExp(`([?&](?:${SECRET_PARAMS})=)[^&#\\s"'<>]+`, "gi");

/**
 * Strip key-shaped fragments before they land in a job row or the app log.
 * Matches `sk-…` tokens, `Bearer …` authorization values, JWT-shaped tokens,
 * `x-api-key: …` headers, credential query parameters, URL userinfo and
 * Zhipu-style `{32 hex}.{16 chars}` keys. Each pattern needs a key-like prefix
 * or shape, so ordinary error text stays readable.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{4,}/g, "sk-…")
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer …")
    // JWT：三段 base64url，头部固定以 `{"` 编码出的 eyJ 开头。
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "eyJ…")
    // 头部写法（日志里的请求转储 / JSON）：x-api-key: xxx、"x-goog-api-key": "xxx"。
    .replace(/\b((?:x-api-key|x-goog-api-key|api-key)["']?\s*[:=]\s*["']?)[A-Za-z0-9\-._~+/]{8,}=*/gi, "$1…")
    .replace(SECRET_PARAM_RE, "$1…")
    // scheme://user:pass@host → scheme://***@host
    // 长度都有上限：不设上限时 `a.a.a…` 或一串 `://` 会让正则回溯成平方级。
    .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#@"'<>]{1,256}@/gi, "$1***@")
    // 智谱 API Key：32 位十六进制 id + "." + 16 位 secret。
    .replace(/\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/g, "…");
}
