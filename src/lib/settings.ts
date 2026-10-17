import { invoke } from "@tauri-apps/api/core";
import type { LlmProviderView, LlmSettings, LlmUsage } from "./types";
import { isTauri, uid } from "./util";

const BROWSER_KEY = "paper-field.llm";

// ---------- 预设表（TS 侧唯一权威；Rust 仅在迁移时持有一份 baseUrl 前缀反查表） ----------

export interface LlmPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** 推荐模型（datalist 候选）；空数组 = 无推荐，靠「获取模型列表」。 */
  models: string[];
  requiresKey: boolean;
}

export const LLM_PRESETS: LlmPreset[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", models: ["gpt-4o-mini", "gpt-4.1-mini"], requiresKey: true },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat", "deepseek-reasoner"], requiresKey: true },
  { id: "moonshot", label: "Kimi (Moonshot)", baseUrl: "https://api.moonshot.cn/v1", models: ["kimi-k2-0905-preview", "kimi-latest"], requiresKey: true },
  { id: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-4.5", "glm-4.5-air", "glm-4-flash"], requiresKey: true },
  { id: "qwen", label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen-plus", "qwen-turbo", "qwen-max"], requiresKey: true },
  { id: "siliconflow", label: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", models: [], requiresKey: true },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", models: [], requiresKey: true },
  { id: "ollama", label: "Ollama 本地", baseUrl: "http://localhost:11434/v1", models: [], requiresKey: false },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1", models: [], requiresKey: false },
];

export function presetById(id: string | null | undefined): LlmPreset | null {
  if (!id) return null;
  return LLM_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** baseUrl 前缀反查预设（迁移与「自定义服务」判定共用；反查不到返回 null）。 */
export function presetForBaseUrl(baseUrl: string): LlmPreset | null {
  const target = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  if (!target) return null;
  let matched: LlmPreset | null = null;
  let matchedLength = 0;
  for (const preset of LLM_PRESETS) {
    const prefix = preset.baseUrl.replace(/\/+$/, "").toLowerCase();
    // 命中 = 预设地址是前缀且边界落在 '/' 或串尾（避免 api.openai.com 误吃相似宿主）；
    // 多预设命中时取最长前缀。
    if (target === prefix || target.startsWith(`${prefix}/`)) {
      if (prefix.length > matchedLength) {
        matched = preset;
        matchedLength = prefix.length;
      }
    }
  }
  return matched;
}

// ---------- 保存入参（apiKey 三态：null=保留已存（按 id 匹配旧记录）、""=清除、非空=写入） ----------

export interface LlmProviderSave {
  id: string;
  presetId: string | null;
  label: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  requiresKey: boolean;
  apiKey: string | null;
}

export interface LlmSaveInput {
  providers: LlmProviderSave[];
}

export interface LlmTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

// ---------- 宽容解析（后端返回 / localStorage 镜像统一入口） ----------

function asProviderView(value: unknown): LlmProviderView | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : null;
  if (!id) return null;
  const presetRaw = typeof raw.presetId === "string" && raw.presetId.trim() ? raw.presetId : null;
  const keyState =
    raw.keyState === "present" || raw.keyState === "absent" || raw.keyState === "unreadable"
      ? raw.keyState
      : undefined;
  const hasKey =
    keyState === "unreadable"
      ? false
      : keyState === "present" || raw.hasKey === true || (typeof raw.apiKey === "string" && Boolean(raw.apiKey.trim()));
  return {
    id,
    presetId: presetRaw && presetById(presetRaw) ? presetRaw : null,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : "自定义服务",
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "",
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    enabled: raw.enabled === true,
    hasKey,
    keyState: keyState ?? (hasKey ? "present" : "absent"),
    requiresKey: raw.requiresKey !== false,
  };
}

export function formatSettingsFileError(file: "llm-settings.json" | "secrets.json", detail: string): string {
  return `${file} 无法读取：${detail}。原文件未改写。`;
}

function asUsage(value: unknown): LlmUsage {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    requests: Number(raw.requests) || 0,
    errors: Number(raw.errors) || 0,
    inputTokens: Number(raw.inputTokens) || 0,
    outputTokens: Number(raw.outputTokens) || 0,
    lastUsedAt: typeof raw.lastUsedAt === "number" && Number.isFinite(raw.lastUsedAt) ? raw.lastUsedAt : null,
  };
}

function normalizeUsageMap(value: unknown): Record<string, LlmUsage> {
  const usage: Record<string, LlmUsage> = {};
  if (value && typeof value === "object") {
    for (const [key, row] of Object.entries(value as Record<string, unknown>)) {
      usage[key] = asUsage(row);
    }
  }
  return usage;
}

/** 同时兼容后端 v2 公共视图与浏览器 v2 镜像（usage 可省）。 */
function normalize(value: unknown): LlmSettings {
  if (!value || typeof value !== "object") return { version: 2, providers: [], usage: {} };
  const raw = value as Record<string, unknown>;
  if (Array.isArray(raw.providers)) {
    const providers = raw.providers
      .map(asProviderView)
      .filter((item): item is LlmProviderView => item !== null);
    return { version: 2, providers, usage: normalizeUsageMap(raw.usage) };
  }
  return { version: 2, providers: [], usage: {} };
}

// ---------- 浏览器镜像（localStorage 键 paper-field.llm 存同构 v2，含明文 apiKey，沿现状） ----------

interface BrowserProviderStore extends LlmProviderView {
  apiKey: string;
}

interface BrowserLlmStore {
  version: 2;
  providers: BrowserProviderStore[];
}

function asBrowserProvider(value: unknown): BrowserProviderStore | null {
  if (!value || typeof value !== "object") return null;
  const view = asProviderView(value);
  if (!view) return null;
  const raw = value as Record<string, unknown>;
  return { ...view, apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "" };
}

/** v1 扁平旧值 {baseUrl, model, apiKey} → v2 单提供商：presetId 由 baseUrl 反查，Key 原样保留。 */
function migrateV1Provider(value: Record<string, unknown>): BrowserProviderStore {
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
  const preset = presetForBaseUrl(baseUrl);
  const apiKey = typeof value.apiKey === "string" ? value.apiKey : "";
  return {
    id: uid(),
    presetId: preset?.id ?? null,
    label: preset?.label ?? "自定义服务",
    baseUrl,
    model: typeof value.model === "string" ? value.model.trim() : "",
    enabled: Boolean(baseUrl),
    hasKey: Boolean(apiKey.trim()),
    keyState: apiKey.trim() ? "present" : "absent",
    requiresKey: preset ? preset.requiresKey : true,
    apiKey,
  };
}

function readBrowserStore(): BrowserLlmStore {
  try {
    const raw = localStorage.getItem(BROWSER_KEY);
    if (!raw) return { version: 2, providers: [] };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 2 || !Array.isArray(parsed.providers)) {
      // v1 旧值只在内存迁移（沿 mineru.ts 的读取侧惯例），下次 save 自然落 v2。
      return { version: 2, providers: [migrateV1Provider(parsed)] };
    }
    const providers = parsed.providers
      .map(asBrowserProvider)
      .filter((item): item is BrowserProviderStore => item !== null);
    return { version: 2, providers };
  } catch {
    return { version: 2, providers: [] };
  }
}

function toPublicView(store: BrowserLlmStore): LlmSettings {
  return {
    version: 2,
    providers: store.providers.map(({ apiKey, ...provider }) => ({
      ...provider,
      hasKey: Boolean(apiKey.trim()),
    })),
    usage: {},
  };
}

// ---------- load / save ----------

export interface LlmSettingsRead {
  settings: LlmSettings;
  llmError: string | null;
  secretsError: string | null;
}

export async function readLlmSettings(): Promise<LlmSettingsRead> {
  if (!isTauri()) {
    return { settings: toPublicView(readBrowserStore()), llmError: null, secretsError: null };
  }
  try {
    const raw = await invoke<Record<string, unknown>>("llm_settings");
    const wrapped = raw.settings && typeof raw.settings === "object";
    const settings = normalize(wrapped ? raw.settings : raw);
    const llmDetail = wrapped && typeof raw.llmError === "string" ? raw.llmError : null;
    const secretsDetail = wrapped && typeof raw.secretsError === "string" ? raw.secretsError : null;
    return {
      settings,
      llmError: llmDetail ? formatSettingsFileError("llm-settings.json", llmDetail) : null,
      secretsError: secretsDetail ? formatSettingsFileError("secrets.json", secretsDetail) : null,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      settings: { version: 2, providers: [], usage: {} },
      llmError: formatSettingsFileError("llm-settings.json", detail),
      secretsError: null,
    };
  }
}

export async function loadSettings(): Promise<LlmSettings> {
  return (await readLlmSettings()).settings;
}

function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).origin.toLowerCase();
  } catch {
    return baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  }
}

export async function saveSettings(input: LlmSaveInput): Promise<LlmSettings> {
  if (isTauri()) {
    // 全量替换；apiKey 三态在边界统一：null=保留已存（后端按 id 匹配旧记录）、""=清除、非空=写入。
    return normalize(await invoke<Record<string, unknown>>("save_llm_settings", { settings: input }));
  }
  const prev = readBrowserStore();
  const byId = new Map(prev.providers.map((provider) => [provider.id, provider]));
  const providers: BrowserProviderStore[] = input.providers.map((provider) => {
    const old = byId.get(provider.id);
    // 三态合并：null=沿用已存 Key、""=清除、非空=写入。沿用只限地址来源不变（与桌面端 keyOrigin 一致），
    // 换了主机就丢弃旧 Key，免得它被发给新填的地址。
    const sameOrigin = old ? originOf(old.baseUrl) === originOf(provider.baseUrl) : false;
    const apiKey = provider.apiKey == null ? (sameOrigin ? old?.apiKey ?? "" : "") : provider.apiKey;
    return {
      id: provider.id,
      presetId: provider.presetId,
      label: provider.label.trim() || "自定义服务",
      baseUrl: provider.baseUrl.trim(),
      model: provider.model.trim(),
      enabled: provider.enabled,
      requiresKey: provider.requiresKey,
      apiKey,
      hasKey: Boolean(apiKey.trim()),
    };
  });
  const store: BrowserLlmStore = { version: 2, providers };
  localStorage.setItem(BROWSER_KEY, JSON.stringify(store));
  return toPublicView(store);
}

// ---------- 测试连接 / 模型发现 ----------

export async function testLlmProvider(providerId: string): Promise<LlmTestResult> {
  if (isTauri()) {
    const row = await invoke<Record<string, unknown>>("llm_test", { providerId });
    return {
      ok: row.ok === true,
      latencyMs: Number(row.latencyMs) || 0,
      message: typeof row.message === "string" ? row.message : "",
    };
  }
  const provider = readBrowserStore().providers.find((item) => item.id === providerId);
  if (!provider) throw new Error("找不到该提供商配置，请先保存。");
  const started = performance.now();
  try {
    const response = await fetch(joinUrl(provider.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: authHeaders(provider.apiKey),
      // 极小请求：与后端 llm_test 同参（不带 response_format）。
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: "Reply with: ok" }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: mergeAbortSignals(undefined, 30_000, "连接超时（30s）：请检查网络或 Base URL。"),
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, latencyMs, message: friendlyLlmError(response.status, extractErrorDetail(text)) };
    }
    return { ok: true, latencyMs, message: "连接正常" };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    return { ok: false, latencyMs, message: `无法连接服务（${errText(err)}），请检查网络与 Base URL。` };
  }
}

export async function listLlmModels(providerId: string): Promise<string[]> {
  if (isTauri()) {
    return invoke<string[]>("llm_list_models", { providerId });
  }
  const provider = readBrowserStore().providers.find((item) => item.id === providerId);
  if (!provider) throw new Error("找不到该提供商配置，请先保存。");
  const response = await fetch(joinUrl(provider.baseUrl, "/models"), {
    headers: authHeaders(provider.apiKey),
    signal: mergeAbortSignals(undefined, 30_000, "获取模型列表超时（30s）。"),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(friendlyLlmError(response.status, extractErrorDetail(text)));
  }
  const json = (await response.json()) as { data?: Array<{ id?: unknown }> };
  const ids = (json.data ?? [])
    .map((row) => (typeof row?.id === "string" ? row.id.trim() : ""))
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

/** 任一 enabled 且（requiresKey ? 已存 Key : 免 Key）即视为可用（门禁派生口径）。 */
export function hasUsableProvider(settings: Pick<LlmSettings, "providers">): boolean {
  return settings.providers.some((provider) => provider.enabled && (!provider.requiresKey || provider.hasKey));
}

// ---------- LLM 请求策略（与 Rust 侧 call_chat 对齐：官方 SDK 语义的有界重试） ----------

const LLM_MAX_RETRIES = 2;
const LLM_BACKOFF_BASE_MS = 800;
const LLM_BACKOFF_JITTER_MS = 400;
/** Retry-After 超过该值视为额度类限流，直接失败而不是白等。 */
const LLM_RETRY_AFTER_CAP_SECS = 30;

/** 带 HTTP 状态码与响应体的错误（可按状态决定是否重试）。 */
class ChatHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterSecs: number | null,
  ) {
    super(`LLM HTTP ${status}`);
  }
}

/** finish_reason / 空内容等确定性失败：重试没有意义。 */
class ChatResultError extends Error {}

export function extractErrorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message.slice(0, 240);
  } catch {
    // 非标准错误体：退回原文截断
  }
  return body.slice(0, 240);
}

export function friendlyLlmError(status: number, detail: string): string {
  if (status === 401 || status === 403) return `LLM 鉴权失败：请检查设置页的 API Key（${detail}）`;
  if (status === 404) return `接口不存在：请检查 Base URL 与模型名（${detail}）`;
  if (status === 429) return `请求被限流或额度不足（${detail}）`;
  if (status >= 500) return `LLM 服务端错误（HTTP ${status}）：${detail}`;
  return `LLM HTTP ${status}：${detail}`;
}

function isResponseFormatRejection(status: number, body: string): boolean {
  if (status !== 400) return false;
  const lower = body.toLowerCase();
  return lower.includes("response_format") || lower.includes("json_object");
}

function backoffDelayMs(attempt: number): number {
  return (LLM_BACKOFF_BASE_MS << attempt) + Math.floor(Math.random() * LLM_BACKOFF_JITTER_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function joinUrl(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, "")}${path}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  // 免 Key 服务（Ollama / LM Studio）不发 Authorization，避免空 Bearer 干扰部分网关。
  const key = apiKey.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** 用户主动取消的判定：只认外部信号（120s 超时同样走 AbortError，但应换下一个提供商而不是终止全部）。 */

async function chatOnce(
  provider: BrowserProviderStore,
  system: string,
  user: string,
  useJsonMode: boolean,
  signal: AbortSignal | undefined,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: provider.model,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (useJsonMode) body.response_format = { type: "json_object" };
  const response = await fetch(joinUrl(provider.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(provider.apiKey) },
    body: JSON.stringify(body),
    // 与后端对齐为 120s 超时；外部取消信号与超时信号合并（兼容无 AbortSignal.any 的环境）。
    signal: mergeAbortSignals(signal, 120_000, "LLM 请求超时（120s），请重试。"),
  });
  if (!response.ok) {
    const text = await response.text();
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new ChatHttpError(response.status, text, retryAfter > 0 ? retryAfter : null);
  }
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  const finishReason = json.choices?.[0]?.finish_reason;
  if (finishReason === "length") {
    throw new ChatResultError(
      "模型输出被截断（finish_reason=length），JSON 可能不完整。请重试，或在设置中换用输出上限更高的模型。",
    );
  }
  if (finishReason === "content_filter") {
    throw new ChatResultError("模型拒绝了这次请求（内容过滤）。");
  }
  const content = json.choices?.[0]?.message?.content;
  if (!content?.trim()) throw new ChatResultError("模型返回为空");
  return content;
}

/** 单提供商内循环：保留原单端点策略（response_format 降级、408/429/5xx/网络错误有界重试）。 */
async function chatWithProvider(
  provider: BrowserProviderStore,
  input: { system: string; user: string; signal?: AbortSignal },
): Promise<string> {
  let useJsonMode = true;
  let attempt = 0;
  for (;;) {
    try {
      return await chatOnce(provider, input.system, input.user, useJsonMode, input.signal);
    } catch (err) {
      if (err instanceof ChatHttpError) {
        // 部分兼容端点不支持 response_format：去掉字段立刻重试一次，不消耗退避预算。
        if (useJsonMode && isResponseFormatRejection(err.status, err.body)) {
          useJsonMode = false;
          continue;
        }
        const detail = extractErrorDetail(err.body);
        const retryable = err.status === 408 || err.status === 429 || err.status >= 500;
        if (!retryable || attempt >= LLM_MAX_RETRIES) {
          throw new Error(friendlyLlmError(err.status, detail));
        }
        let delay = backoffDelayMs(attempt);
        if (err.retryAfterSecs !== null) {
          if (err.retryAfterSecs > LLM_RETRY_AFTER_CAP_SECS) {
            throw new Error(`请求被限流（服务端要求等待 ${err.retryAfterSecs} 秒），已停止重试：${detail}`);
          }
          delay = err.retryAfterSecs * 1000;
        }
        await sleep(delay);
        attempt += 1;
        continue;
      }
      if (err instanceof ChatResultError) throw err;
      // 用户主动取消与超时中断不重试；其余（网络 TypeError 等）按传输层错误有界重试。
      if (input.signal?.aborted || (err as DOMException)?.name === "AbortError" || attempt >= LLM_MAX_RETRIES) {
        throw err;
      }
      await sleep(backoffDelayMs(attempt));
      attempt += 1;
    }
  }
}

export async function completeChat(input: {
  jobId: string;
  system: string;
  user: string;
  signal?: AbortSignal;
}): Promise<string> {
  if (isTauri()) {
    return invoke<string>("llm_complete", {
      jobId: input.jobId,
      systemPrompt: input.system,
      userPrompt: input.user,
    });
  }

  const store = readBrowserStore();
  // 依序尝试 enabled 且（requiresKey ? 已存 Key : 免 Key）的 providers。
  const candidates = store.providers.filter(
    (provider) => provider.enabled && (!provider.requiresKey || provider.apiKey.trim()),
  );
  if (!candidates.length) throw new Error("NO_API_KEY");
  const failures: string[] = [];
  for (const provider of candidates) {
    try {
      return await chatWithProvider(provider, input);
    } catch (err) {
      // 用户取消立即传播：不得被吞、不得转移到下一个提供商。
      if (input.signal?.aborted) throw err;
      failures.push(`${provider.label}：${errText(err)}`);
    }
  }
  // 全部失败：聚合各提供商错误（风格同 mineru.rs 的 aggregate_failures）。
  throw new Error(failures.join("；"));
}

function mergeAbortSignals(external: AbortSignal | undefined, timeoutMs: number, message: string): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(message), timeoutMs);
  // 任何一方触发后都清掉计时器（fetch 正常完成且未 abort 时，timer 到期后自然结束，无泄漏）。
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  if (external) {
    if (external.aborted) {
      controller.abort(external.reason);
    } else {
      external.addEventListener("abort", () => controller.abort(external.reason), { once: true });
    }
  }
  return controller.signal;
}

export async function cancelChat(jobId: string): Promise<void> {
  if (isTauri()) {
    await invoke("llm_cancel", { jobId });
  }
}
