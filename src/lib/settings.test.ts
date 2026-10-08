import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmProviderView } from "./types";
import {
  LLM_PRESETS,
  completeChat,
  extractErrorDetail,
  friendlyLlmError,
  hasUsableProvider,
  listLlmModels,
  loadSettings,
  presetForBaseUrl,
  saveSettings,
  testLlmProvider,
  type LlmProviderSave,
} from "./settings";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({ version: 2, providers: [], usage: {} })),
}));

/** mock invoke 路径：需要 isTauri() 为 true（window.__TAURI_INTERNALS__）；浏览器分支单独覆盖。 */
function asTauri() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
}

function asBrowser() {
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
}

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

/** 浏览器 localStorage 的 v2 存档条目（含明文 apiKey）。 */
function storedProvider(overrides: Partial<LlmProviderSave & { apiKey: string }> = {}) {
  return {
    id: "p-1",
    presetId: null,
    label: "服务一",
    baseUrl: "https://one.test/v1",
    model: "m-1",
    enabled: true,
    requiresKey: true,
    apiKey: "sk-1",
    ...overrides,
  };
}

function primeBrowser(providers: Array<ReturnType<typeof storedProvider>>) {
  localStorage.setItem("paper-field.llm", JSON.stringify({ version: 2, providers }));
}

function saveProvider(overrides: Partial<LlmProviderSave> = {}): LlmProviderSave {
  return {
    id: "p-1",
    presetId: null,
    label: "服务一",
    baseUrl: "https://one.test/v1",
    model: "m-1",
    enabled: true,
    requiresKey: true,
    apiKey: null,
    ...overrides,
  };
}

beforeEach(() => {
  asBrowser();
  primeBrowser([storedProvider()]);
});

afterEach(() => {
  asBrowser();
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

describe("预设表与 baseUrl 反查", () => {
  it("LLM_PRESETS 覆盖规格所列九个预设（含免 Key 本地服务）", () => {
    expect(LLM_PRESETS.map((preset) => preset.id)).toEqual([
      "openai",
      "deepseek",
      "moonshot",
      "zhipu",
      "qwen",
      "siliconflow",
      "openrouter",
      "ollama",
      "lmstudio",
    ]);
    expect(LLM_PRESETS.find((p) => p.id === "ollama")).toMatchObject({
      baseUrl: "http://localhost:11434/v1",
      requiresKey: false,
    });
    expect(LLM_PRESETS.find((p) => p.id === "zhipu")?.models).toEqual(["glm-4.5", "glm-4.5-air", "glm-4-flash"]);
  });

  it("presetForBaseUrl 精确 / 尾斜杠 / 子路径都命中同一预设", () => {
    expect(presetForBaseUrl("https://api.deepseek.com/v1")?.id).toBe("deepseek");
    expect(presetForBaseUrl("https://api.deepseek.com/v1/")?.id).toBe("deepseek");
    expect(presetForBaseUrl("https://api.openai.com/v1/responses")?.id).toBe("openai");
  });

  it("反查不到（含前缀相似的不同宿主、空值）返回 null", () => {
    expect(presetForBaseUrl("https://api.openai.com.evil.cn/v1")).toBeNull();
    expect(presetForBaseUrl("https://my-proxy.example/v1")).toBeNull();
    expect(presetForBaseUrl("  ")).toBeNull();
  });
});

describe("completeChat · 浏览器多提供商回退", () => {
  it("401 不做同端点重试，直接换下一个提供商成功", async () => {
    primeBrowser([
      storedProvider(),
      storedProvider({ id: "p-2", label: "服务二", baseUrl: "https://two.test/v1", apiKey: "sk-2" }),
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: "Incorrect API key" } }))
      .mockResolvedValueOnce(okChoice());
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeChat(INPUT)).resolves.toBe('{"title":"T"}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][0] as string).startsWith("https://one.test/v1/chat/completions")).toBe(true);
    expect((fetchMock.mock.calls[1][0] as string).startsWith("https://two.test/v1/chat/completions")).toBe(true);
  });

  it("404（接口不存在）同样直接换下一个提供商", async () => {
    primeBrowser([
      storedProvider(),
      storedProvider({ id: "p-2", label: "服务二", baseUrl: "https://two.test/v1" }),
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { error: { message: "no route" } }))
      .mockResolvedValueOnce(okChoice());
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeChat(INPUT)).resolves.toBe('{"title":"T"}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("429 在单提供商内退避重试耗尽后换下一个", async () => {
    vi.useFakeTimers();
    primeBrowser([
      storedProvider(),
      storedProvider({ id: "p-2", label: "服务二", baseUrl: "https://two.test/v1" }),
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "Rate limit" } }))
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "Rate limit" } }))
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "Rate limit" } }))
      .mockResolvedValueOnce(okChoice());
    vi.stubGlobal("fetch", fetchMock);

    const promise = completeChat(INPUT);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toBe('{"title":"T"}');
    // 1 次首发 + 2 次重试都在服务一，之后落到服务二。
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((fetchMock.mock.calls[3][0] as string).startsWith("https://two.test/v1")).toBe(true);
  });

  it("Retry-After 超过上限直接判该提供商失败并换下一个", async () => {
    primeBrowser([
      storedProvider(),
      storedProvider({ id: "p-2", label: "服务二", baseUrl: "https://two.test/v1" }),
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(429, { error: { message: "quota exhausted" } }, { "retry-after": "120" }),
      )
      .mockResolvedValueOnce(okChoice());
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeChat(INPUT)).resolves.toBe('{"title":"T"}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("response_format 被拒时在同一提供商内去掉该字段重试一次", async () => {
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

  it("finish_reason=length 不做同端点重试，换下一个提供商", async () => {
    primeBrowser([
      storedProvider(),
      storedProvider({ id: "p-2", label: "服务二", baseUrl: "https://two.test/v1" }),
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okChoice({ message: { content: '{"title":"T"' }, finish_reason: "length" }),
      )
      .mockResolvedValueOnce(okChoice());
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeChat(INPUT)).resolves.toBe('{"title":"T"}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("仅一个提供商且确定性失败时，聚合错误带 label 前缀", async () => {
    const fetchMock = vi.fn(
      async () =>
        okChoice({ message: { content: '{"title":"T"' }, finish_reason: "length" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeChat(INPUT)).rejects.toThrow(/服务一：.*被截断/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("全部失败时按顺序聚合各提供商错误（分号分隔）", async () => {
    primeBrowser([
      storedProvider(),
      storedProvider({ id: "p-2", label: "服务二", baseUrl: "https://two.test/v1", apiKey: "sk-2" }),
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: "Incorrect API key" } }))
      .mockResolvedValueOnce(jsonResponse(404, { error: { message: "no route" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeChat(INPUT)).rejects.toThrow(/服务一：LLM 鉴权失败：.*；服务二：接口不存在：.*/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("用户取消立即传播：不转移到下一个提供商", async () => {
    primeBrowser([
      storedProvider(),
      storedProvider({ id: "p-2", label: "服务二", baseUrl: "https://two.test/v1" }),
    ]);
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return okChoice();
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeChat({ ...INPUT, signal: controller.signal })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("免 Key 提供商（requiresKey=false）无 Key 即可用，且不发 Authorization", async () => {
    primeBrowser([
      storedProvider({ id: "p-local", presetId: "ollama", label: "Ollama 本地", baseUrl: "http://localhost:11434/v1", requiresKey: false, apiKey: "" }),
    ]);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okChoice());
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeChat(INPUT)).resolves.toBe('{"title":"T"}');
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("没有任何可用 provider（未配置 / 未启用 / 缺 Key）时抛 NO_API_KEY", async () => {
    primeBrowser([
      storedProvider({ enabled: false }),
      storedProvider({ id: "p-2", apiKey: "" }),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => okChoice()));

    await expect(completeChat(INPUT)).rejects.toThrow("NO_API_KEY");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("loadSettings / saveSettings · 浏览器 v2 与 v1 迁移", () => {
  it("v1 扁平 deepseek 值读取时迁为单提供商：presetId 反查命中、Key 保留、label 取预设名", async () => {
    localStorage.setItem(
      "paper-field.llm",
      JSON.stringify({ baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk-old" }),
    );
    const settings = await loadSettings();
    expect(settings.version).toBe(2);
    expect(settings.providers).toHaveLength(1);
    expect(settings.providers[0]).toMatchObject({
      presetId: "deepseek",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      enabled: true,
      hasKey: true,
      requiresKey: true,
    });
    expect(settings.usage).toEqual({});
    // 迁移只在读取侧生效（沿 mineru.ts 惯例）：存档保持原样，下次 save 才落 v2。
    expect(JSON.parse(localStorage.getItem("paper-field.llm")!)).toMatchObject({ baseUrl: "https://api.deepseek.com/v1" });
  });

  it("v1 未知 baseUrl 迁为「自定义服务」（presetId=null、默认需 Key）", async () => {
    localStorage.setItem(
      "paper-field.llm",
      JSON.stringify({ baseUrl: "https://my-proxy.example/v1", model: "m", apiKey: "k" }),
    );
    const settings = await loadSettings();
    expect(settings.providers[0]).toMatchObject({
      presetId: null,
      label: "自定义服务",
      requiresKey: true,
      hasKey: true,
    });
  });

  it("无历史值时回落空 v2（无可用提供商）", async () => {
    localStorage.removeItem("paper-field.llm");
    const settings = await loadSettings();
    expect(settings).toEqual({ version: 2, providers: [], usage: {} });
    expect(hasUsableProvider(settings)).toBe(false);
  });

  it("hasUsableProvider 派生口径：enabled +（requiresKey ? hasKey : 免 Key）", () => {
    const view = (overrides: Partial<LlmProviderView> = {}): LlmProviderView => ({
      id: "p-1",
      presetId: null,
      label: "服务一",
      baseUrl: "https://one.test/v1",
      model: "m-1",
      enabled: true,
      hasKey: true,
      requiresKey: true,
      ...overrides,
    });
    expect(hasUsableProvider({ providers: [view({ enabled: false })] })).toBe(false);
    expect(hasUsableProvider({ providers: [view({ hasKey: false })] })).toBe(false);
    expect(hasUsableProvider({ providers: [view()] })).toBe(true);
    expect(
      hasUsableProvider({
        providers: [view({ presetId: "ollama", requiresKey: false, hasKey: false })],
      }),
    ).toBe(true);
  });

  it("saveSettings 三态：null=保留已存、空串=清除、非空=写入（按 id 匹配旧记录）", async () => {
    primeBrowser([
      storedProvider(),
      storedProvider({ id: "p-2", label: "服务二", baseUrl: "https://two.test/v1", apiKey: "sk-2" }),
    ]);
    const saved = await saveSettings({
      providers: [
        saveProvider({ apiKey: null }), // 保留 sk-1
        saveProvider({ id: "p-2", label: "服务二", baseUrl: "https://two.test/v1", apiKey: "" }), // 清除
        saveProvider({ id: "p-3", label: "服务三", baseUrl: "https://three.test/v1", apiKey: "sk-3" }), // 写入
      ],
    });
    expect(saved.version).toBe(2);
    expect(saved.providers.map((p) => [p.id, p.hasKey])).toEqual([
      ["p-1", true],
      ["p-2", false],
      ["p-3", true],
    ]);
    // 存档落 v2 且明文 Key 按三态合并。
    const store = JSON.parse(localStorage.getItem("paper-field.llm")!) as { version: number; providers: Array<{ id: string; apiKey: string }> };
    expect(store.version).toBe(2);
    expect(store.providers.map((p) => [p.id, p.apiKey])).toEqual([
      ["p-1", "sk-1"],
      ["p-2", ""],
      ["p-3", "sk-3"],
    ]);
  });

  it("loadSettings 把后端 v2 公共视图宽容规范化（含 usage、过滤无效行）", async () => {
    asTauri();
    vi.mocked(invoke).mockResolvedValue({
      version: 2,
      providers: [
        {
          id: "p-1",
          presetId: "deepseek",
          label: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-chat",
          enabled: true,
          hasKey: true,
          requiresKey: true,
        },
        { presetId: "bad", label: "无 id 行被丢弃" },
      ],
      usage: { "p-1": { requests: 3, errors: 1, inputTokens: 120, outputTokens: 80, lastUsedAt: 1720000000000 } },
    });
    const settings = await loadSettings();
    expect(invoke).toHaveBeenCalledWith("llm_settings");
    expect(settings.providers).toHaveLength(1);
    expect(settings.providers[0]).toMatchObject({ id: "p-1", presetId: "deepseek", hasKey: true });
    expect(settings.usage["p-1"]).toEqual({
      requests: 3,
      errors: 1,
      inputTokens: 120,
      outputTokens: 80,
      lastUsedAt: 1720000000000,
    });
  });
});

describe("saveSettings · Tauri 边界载荷", () => {
  beforeEach(() => asTauri());

  afterEach(() => {
    asBrowser();
    vi.mocked(invoke).mockClear();
  });

  it("载荷为 { settings: { providers } }，apiKey 三态原样传递", async () => {
    await saveSettings({
      providers: [
        saveProvider({ apiKey: null }), // 保留已存（undefined 已在类型层排除）
        saveProvider({ id: "p-2", label: "服务二", baseUrl: "https://two.test/v1", apiKey: "" }), // 清除
        saveProvider({ id: "p-3", label: "服务三", baseUrl: "https://three.test/v1", apiKey: "sk-3" }), // 写入
      ],
    });
    expect(invoke).toHaveBeenCalledWith("save_llm_settings", {
      settings: {
        providers: [
          expect.objectContaining({ id: "p-1", apiKey: null }),
          expect.objectContaining({ id: "p-2", apiKey: "" }),
          expect.objectContaining({ id: "p-3", apiKey: "sk-3" }),
        ],
      },
    });
  });
});

describe("testLlmProvider / listLlmModels", () => {
  it("Tauri：llm_test 结果按公共视图宽容解析", async () => {
    asTauri();
    vi.mocked(invoke).mockResolvedValue({ ok: true, latencyMs: 123, message: "连接正常" });
    await expect(testLlmProvider("p-1")).resolves.toEqual({ ok: true, latencyMs: 123, message: "连接正常" });
    expect(invoke).toHaveBeenCalledWith("llm_test", { providerId: "p-1" });
  });

  it("Tauri：llm_list_models 透传字符串数组", async () => {
    asTauri();
    vi.mocked(invoke).mockResolvedValue(["glm-4.5", "glm-4.5-air"]);
    await expect(listLlmModels("p-1")).resolves.toEqual(["glm-4.5", "glm-4.5-air"]);
    expect(invoke).toHaveBeenCalledWith("llm_list_models", { providerId: "p-1" });
  });

  it("浏览器：极小请求测连通（max_tokens=8、temperature=0、无 response_format）", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, { choices: [{ message: { content: "ok" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await testLlmProvider("p-1");
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.message).toBe("连接正常");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://one.test/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "m-1",
      max_tokens: 8,
      temperature: 0,
      messages: [{ role: "user", content: "Reply with: ok" }],
    });
    expect(body.response_format).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-1");
  });

  it("浏览器：测试失败返回 {ok:false} 与中文可行动信息", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: { message: "Incorrect API key" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testLlmProvider("p-1");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("API Key");
  });

  it("浏览器：listLlmModels 解析 data[].id 去重排序", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        jsonResponse(200, { data: [{ id: "glm-4.5-air" }, { id: "glm-4.5" }, { id: "glm-4.5" }, { id: 1 }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listLlmModels("p-1")).resolves.toEqual(["glm-4.5", "glm-4.5-air"]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://one.test/v1/models");
  });

  it("浏览器：listLlmModels 失败抛中文原因", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, { error: { message: "upstream down" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listLlmModels("p-1")).rejects.toThrow(/服务端错误/);
  });

  it("未知 providerId：直接指引先保存", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(testLlmProvider("nope")).rejects.toThrow("找不到该提供商配置，请先保存。");
    await expect(listLlmModels("nope")).rejects.toThrow("找不到该提供商配置，请先保存。");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
