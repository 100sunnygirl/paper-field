import { invoke } from "@tauri-apps/api/core";
import type { LlmSettings } from "./types";
import { isTauri } from "./util";

const BROWSER_KEY = "paper-field.llm";
const DEFAULT_BASE = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

interface StoredSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
}

function emptyStored(): StoredSettings {
  return { baseUrl: DEFAULT_BASE, model: DEFAULT_MODEL, apiKey: "" };
}

function readBrowser(): StoredSettings {
  try {
    const raw = localStorage.getItem(BROWSER_KEY);
    if (!raw) return emptyStored();
    const parsed = JSON.parse(raw) as Partial<StoredSettings>;
    return {
      baseUrl: parsed.baseUrl?.trim() || DEFAULT_BASE,
      model: parsed.model?.trim() || DEFAULT_MODEL,
      apiKey: parsed.apiKey ?? "",
    };
  } catch {
    return emptyStored();
  }
}

export async function loadSettings(): Promise<LlmSettings & { apiKey?: string }> {
  if (isTauri()) {
    const value = await invoke<{ baseUrl: string; model: string; hasKey: boolean }>("llm_settings");
    return {
      baseUrl: value.baseUrl || DEFAULT_BASE,
      model: value.model || DEFAULT_MODEL,
      hasKey: value.hasKey,
    };
  }
  const stored = readBrowser();
  return {
    baseUrl: stored.baseUrl,
    model: stored.model,
    hasKey: Boolean(stored.apiKey.trim()),
    apiKey: stored.apiKey,
  };
}

export async function saveSettings(input: {
  baseUrl: string;
  model: string;
  apiKey?: string;
}): Promise<void> {
  if (isTauri()) {
    await invoke("save_llm_settings", {
      baseUrl: input.baseUrl.trim() || DEFAULT_BASE,
      model: input.model.trim() || DEFAULT_MODEL,
      apiKey: input.apiKey,
    });
    return;
  }
  const prev = readBrowser();
  const next: StoredSettings = {
    baseUrl: input.baseUrl.trim() || DEFAULT_BASE,
    model: input.model.trim() || DEFAULT_MODEL,
    apiKey: input.apiKey === undefined ? prev.apiKey : input.apiKey,
  };
  localStorage.setItem(BROWSER_KEY, JSON.stringify(next));
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

async function chatOnce(
  stored: StoredSettings,
  system: string,
  user: string,
  useJsonMode: boolean,
  signal: AbortSignal | undefined,
): Promise<string> {
  const url = `${stored.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    model: stored.model,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (useJsonMode) body.response_format = { type: "json_object" };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${stored.apiKey.trim()}`,
    },
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

  const stored = readBrowser();
  if (!stored.apiKey.trim()) {
    throw new Error("NO_API_KEY");
  }
  let useJsonMode = true;
  let attempt = 0;
  for (;;) {
    try {
      return await chatOnce(stored, input.system, input.user, useJsonMode, input.signal);
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
      // 用户主动取消不重试；其余（网络 TypeError 等）按传输层错误有界重试。
      if (input.signal?.aborted || (err as DOMException)?.name === "AbortError" || attempt >= LLM_MAX_RETRIES) {
        throw err;
      }
      await sleep(backoffDelayMs(attempt));
      attempt += 1;
    }
  }
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
