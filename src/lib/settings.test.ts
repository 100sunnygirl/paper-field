import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { completeChat, extractErrorDetail, friendlyLlmError, saveSettings } from "./settings";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({ baseUrl: "", model: "", hasKey: false })),
}));

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function okChoice(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse(200, {
    choices: [{ message: { content: '{"title":"T"}' }, finish_reason: "stop", ...overrides }],
  });
}

const INPUT = { jobId: "job-1", system: "Return ONLY valid JSON", user: "Title: T" };

beforeEach(() => {
  localStorage.setItem(
    "paper-field.llm",
    JSON.stringify({ baseUrl: "https://api.test/v1", model: "test-model", apiKey: "sk-x" }),
  );
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("错误映射（与 Rust 侧对齐）", () => {
  it("extractErrorDetail 优先标准 error.message", () => {
    expect(
      extractErrorDetail('{"error":{"message":"Incorrect API key","code":"invalid_api_key"}}'),
    ).toBe("Incorrect API key");
    expect(extractErrorDetail("plain text")).toBe("plain text");
  });

  it("friendlyLlmError 给出可行动的中文提示", () => {
    expect(friendlyLlmError(401, "bad key")).toContain("API Key");
    expect(friendlyLlmError(404, "no route")).toContain("Base URL");
    expect(friendlyLlmError(429, "slow")).toContain("限流");
    expect(friendlyLlmError(500, "boom")).toContain("服务端");
  });
});

describe("completeChat · 浏览器分支重试策略", () => {
  it("401 不重试，直接给出鉴权友好提示", async () => {
    const fetchMock = vi.fn(
      async () => jsonResponse(401, { error: { message: "Incorrect API key" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeChat(INPUT)).rejects.toThrow(/API Key/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("429 后成功：退避一次后重试成功", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "Rate limit" } }))
      .mockResolvedValueOnce(okChoice());
    vi.stubGlobal("fetch", fetchMock);

    const promise = completeChat(INPUT);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toBe('{"title":"T"}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Retry-After 超过上限视为额度类限流，停止重试", async () => {
    const fetchMock = vi.fn(
      async () =>
        jsonResponse(429, { error: { message: "quota exhausted" } }, { "retry-after": "120" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeChat(INPUT)).rejects.toThrow(/已停止重试/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("response_format 被拒时去掉该字段重试一次", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(400, { error: { message: "'response_format' is not supported" } }),
      )
      .mockResolvedValueOnce(okChoice());
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeChat(INPUT)).resolves.toBe('{"title":"T"}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(retryBody.response_format).toBeUndefined();
    const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(firstBody.response_format).toEqual({ type: "json_object" });
  });

  it("finish_reason=length 报截断且不重试", async () => {
    const fetchMock = vi.fn(
      async () =>
        okChoice({
          message: { content: '{"title":"T"' },
          finish_reason: "length",
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeChat(INPUT)).rejects.toThrow(/被截断/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("未配置 Key 时抛 NO_API_KEY", async () => {
    localStorage.removeItem("paper-field.llm");
    await expect(completeChat(INPUT)).rejects.toThrow("NO_API_KEY");
  });
});

describe("saveSettings · Tauri 边界三态（缺陷：undefined 丢字段）", () => {
  function asTauri() {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  }

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
    vi.mocked(invoke).mockClear();
  });

  it("留空(undefined) → 显式传 null：字段不丢，后端保留已存 Key", async () => {
    asTauri();
    await saveSettings({ baseUrl: "https://x/v1", model: "m" });
    expect(invoke).toHaveBeenCalledWith("save_llm_settings", {
      baseUrl: "https://x/v1",
      model: "m",
      apiKey: null,
    });
  });

  it("空串原样传递（= 清除已存 Key）", async () => {
    asTauri();
    await saveSettings({ baseUrl: "https://x/v1", model: "m", apiKey: "" });
    expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({ apiKey: "" });
  });

  it("有值原样传递（trim 由后端负责）", async () => {
    asTauri();
    await saveSettings({ baseUrl: "https://x/v1", model: "m", apiKey: "sk-1" });
    expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({ apiKey: "sk-1" });
  });
});
