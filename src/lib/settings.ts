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
  const url = `${stored.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${stored.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: stored.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    }),
    // 浏览器分支此前无超时（桌面端由 Rust 侧限时）：与后端对齐为 120s，
    // 并把外部取消信号与超时信号合并（手动转发，兼容无 AbortSignal.any 的环境）。
    signal: mergeAbortSignals(input.signal, 120_000, "LLM 请求超时（120s），请重试。"),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型返回为空");
  return content;
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
