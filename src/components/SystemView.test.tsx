import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemView } from "./SystemView";
import { useField } from "../store";
import { DEFAULT_MINERU, type MineruSaveInput, type MineruSettingsV2 } from "../lib/mineru";
import { clear as clearLog, log } from "../lib/logger";
import type { ProviderHealth } from "../lib/mineru";
import type { LlmProviderView, LlmSettings } from "../lib/types";
import type { LlmSaveInput } from "../lib/settings";

function mineruState(overrides: Partial<MineruSettingsV2> = {}): MineruSettingsV2 {
  return {
    ...DEFAULT_MINERU,
    local: { enabled: true, socketPath: "~/.mineru/doclib.sock" },
    ssh: { ...DEFAULT_MINERU.ssh, enabled: true, host: "imac" },
    api: { ...DEFAULT_MINERU.api, hasToken: true },
    configured: true,
    ...overrides,
  };
}

function healths(list: Array<[ProviderHealth["provider"], boolean, string]>): ProviderHealth[] {
  return list.map(([provider, ok, message]) => ({ provider, ok, latencyMs: ok ? 15 : 0, message }));
}

describe("SystemView · MinerU 三源卡片", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  it("渲染三张来源卡片：本地 CLI / SSH 远程 / 官方 API，各带测试连接按钮", () => {
    useField.setState({ mineru: mineruState(), effectiveProvider: "local" });
    render(<SystemView />);
    for (const label of ["本地 CLI", "SSH 远程", "官方 API"]) {
      expect(screen.getByRole("region", { name: label })).toBeInTheDocument();
    }
    const buttons = screen.getAllByRole("button", { name: "测试连接" });
    expect(buttons).toHaveLength(3);
  });

  it("SSH 卡片保留 doclib.sock 兼容字段（主机/端口/私钥/远程 Socket/暂存目录）", () => {
    useField.setState({ mineru: mineruState() });
    render(<SystemView />);
    const ssh = screen.getByRole("region", { name: "SSH 远程" });
    fireEvent.click(within(ssh).getByRole("button", { name: "高级" }));
    for (const label of ["主机", "端口", "用户", "私钥路径", "远程 Socket 路径", "远程暂存目录"]) {
      expect(within(ssh).getByText(label)).toBeInTheDocument();
    }
    expect(
      within(ssh).getByText(/连接另一台电脑上已部署的 MinerU，PDF 会先复制到远程暂存目录/),
    ).toBeInTheDocument();
  });

  it("生效源显示「当前生效」与卡片「生效中」徽章", () => {
    useField.setState({ mineru: mineruState(), effectiveProvider: "ssh" });
    render(<SystemView />);
    expect(screen.getByText(/当前生效：/)).toHaveTextContent("SSH 远程");
    const sshCard = screen.getByRole("region", { name: "SSH 远程" });
    expect(within(sshCard).getByText("生效中")).toBeInTheDocument();
  });

  it("已启用但全部探测失败：显示失败原因聚合（分号分隔，含各源中文标签）", () => {
    useField.setState({
      mineru: mineruState(),
      effectiveProvider: null,
      mineruHealth: healths([
        ["local", false, "socket 文件不存在"],
        ["ssh", false, "连接超时"],
        ["api", false, "Token 无效"],
      ]),
    });
    render(<SystemView />);
    expect(screen.getByText(/已启用的解析源均未通过探测/)).toBeInTheDocument();
    expect(
      screen.getByText(/本地 CLI：socket 文件不存在；SSH 远程：连接超时；官方 API：Token 无效/),
    ).toBeInTheDocument();
  });

  it("未启用任何源：显示「尚未启用任何解析源，导入仅入库。」", () => {
    useField.setState({ mineru: mineruState({ configured: false, local: { enabled: false, socketPath: "~/.mineru/doclib.sock" }, ssh: { ...DEFAULT_MINERU.ssh }, api: { ...DEFAULT_MINERU.api } }) });
    render(<SystemView />);
    expect(screen.getByText("尚未启用任何解析源，导入将只入库、不解析。")).toBeInTheDocument();
  });

  it("探测成功的源显示延迟毫秒数", () => {
    useField.setState({
      mineru: mineruState(),
      effectiveProvider: "local",
      mineruHealth: healths([["local", true, "doclib 可达"]]),
    });
    render(<SystemView />);
    expect(screen.getByText(/doclib 可达/)).toHaveTextContent("15ms");
  });
});

describe("SystemView · 回退顺序调整", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  function orderChips(): string[] {
    const group = screen.getByRole("group", { name: "回退顺序" });
    return Array.from(group.querySelectorAll(".ef-order-chip")).map(
      (chip) => chip.textContent?.replace(/↑|↓/g, "") ?? "",
    );
  }

  it("按 order 渲染顺序 chips，首位无上移、末位无下移", () => {
    useField.setState({ mineru: mineruState(), effectiveProvider: "local" });
    render(<SystemView />);
    expect(orderChips()).toEqual(["本地 CLI", "SSH 远程", "官方 API"]);
    expect(screen.getByRole("button", { name: "上移本地 CLI" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下移官方 API" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "上移SSH 远程" })).toBeEnabled();
  });

  it("点击「上移SSH 远程」立即保存新顺序（顺序即回退优先级）", async () => {
    const saveMineruSettings = vi.fn(async (_input: MineruSaveInput) => undefined);
    useField.setState({
      mineru: mineruState(),
      effectiveProvider: "local",
      saveMineruSettings,
    });
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "上移SSH 远程" }));
    await waitFor(() => expect(saveMineruSettings).toHaveBeenCalledTimes(1));
    const input = saveMineruSettings.mock.calls[0]![0]!;
    expect(input.order).toEqual(["ssh", "local", "api"]);
    // chips 立即反映新顺序
    expect(orderChips()).toEqual(["SSH 远程", "本地 CLI", "官方 API"]);
  });

  it("点击「下移本地 CLI」相邻交换保存 [ssh, local, api]；再下移到末尾得 [ssh, api, local]", async () => {
    const saveMineruSettings = vi.fn(async (_input: MineruSaveInput) => undefined);
    useField.setState({ mineru: mineruState(), effectiveProvider: null, saveMineruSettings });
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "下移本地 CLI" }));
    await waitFor(() => expect(saveMineruSettings).toHaveBeenCalledTimes(1));
    expect(saveMineruSettings.mock.calls[0]![0].order).toEqual(["ssh", "local", "api"]);
    // 本地 CLI 现在排第二，继续下移到末尾。
    fireEvent.click(screen.getByRole("button", { name: "下移本地 CLI" }));
    await waitFor(() => expect(saveMineruSettings).toHaveBeenCalledTimes(2));
    expect(saveMineruSettings.mock.calls[1]![0].order).toEqual(["ssh", "api", "local"]);
  });

  it("「重新探测全部」触发 probeMineru", async () => {
    const probeMineru = vi.fn(async () => []);
    useField.setState({ mineru: mineruState(), effectiveProvider: "local", probeMineru });
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "重新探测全部" }));
    await waitFor(() => expect(probeMineru).toHaveBeenCalledTimes(1));
  });

  it("「测试连接」失败时在对应卡片显示中文错误（浏览器预览不可连）", async () => {
    useField.setState({ mineru: mineruState(), effectiveProvider: "local" });
    render(<SystemView />);
    const localCard = screen.getByRole("region", { name: "本地 CLI" });
    fireEvent.click(within(localCard).getByRole("button", { name: "测试连接" }));
    await waitFor(() =>
      expect(within(localCard).getByText(/浏览器预览无法连接 MinerU，请使用桌面应用/)).toBeInTheDocument(),
    );
  });

  it("保存设置按钮调用 saveMineruSettings 并显示已启用来源数", async () => {
    const saveMineruSettings = vi.fn(async (_input: MineruSaveInput) => undefined);
    useField.setState({ mineru: mineruState(), effectiveProvider: "local", saveMineruSettings });
    render(<SystemView />);
    const mineruBlock = screen.getByText("MinerU 解析源").closest("article") as HTMLElement;
    fireEvent.click(within(mineruBlock).getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(saveMineruSettings).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/MinerU 设置已保存（已启用 3 个解析源）/)).toBeInTheDocument();
  });
});

// ---------- AI 服务设置（多提供商 v2）：状态条 / 卡片 / 预设 / 三态 Key / 测试 / 增删排序 / 用量 ----------

function llmProviderViews(): LlmProviderView[] {
  return [
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
    {
      id: "p-2",
      presetId: null,
      label: "自定义服务",
      baseUrl: "https://my-proxy.example/v1",
      model: "m-2",
      enabled: true,
      hasKey: false,
      requiresKey: true,
    },
  ];
}

function llmSettings(overrides: Partial<LlmSettings> = {}): LlmSettings {
  return {
    version: 2,
    providers: llmProviderViews(),
    usage: {
      "p-1": { requests: 5, errors: 1, inputTokens: 1200, outputTokens: 800, lastUsedAt: Date.UTC(2024, 6, 3, 9, 30) },
    },
    ...overrides,
  };
}

/** 浏览器镜像存档（含明文 apiKey）：testLlmProvider / listLlmModels 按已保存配置发请求。 */
function primeLlmBrowser() {
  localStorage.setItem(
    "paper-field.llm",
    JSON.stringify({
      version: 2,
      providers: [
        {
          id: "p-1",
          presetId: "deepseek",
          label: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-chat",
          enabled: true,
          requiresKey: true,
          apiKey: "sk-1",
        },
      ],
    }),
  );
}

function llmBlock(): HTMLElement {
  return screen.getByText("AI 服务设置").closest("article") as HTMLElement;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("SystemView · AI 服务设置（多提供商）", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("状态条统计已启用数、标出首个可用提供商「生效中」，缺 Key 的卡片无徽标", () => {
    useField.setState({ settings: llmSettings() });
    render(<SystemView />);
    expect(screen.getByText(/已启用 2 个提供商/)).toHaveTextContent("DeepSeek");
    expect(screen.getByText("按顺序自动回退")).toBeInTheDocument();
    const first = screen.getByRole("region", { name: "DeepSeek" });
    expect(within(first).getByText("生效中")).toBeInTheDocument();
    const second = screen.getByRole("region", { name: "自定义服务" });
    expect(within(second).queryByText("生效中")).not.toBeInTheDocument();
  });

  it("未配置任何提供商：状态条引导去配置，不渲染卡片与用量表", () => {
    useField.setState({ settings: { version: 2, providers: [], usage: {} } });
    render(<SystemView />);
    expect(screen.getByText(/尚未配置任何 AI 服务/)).toBeInTheDocument();
    expect(llmBlock().querySelectorAll(".ef-provider-card")).toHaveLength(0);
    expect(within(llmBlock()).queryByRole("table")).not.toBeInTheDocument();
  });

  it("预设下拉选中智谱：自动填充 baseUrl / label / 推荐模型，并随保存提交", async () => {
    const saveLlmSettings = vi.fn(async (_input: LlmSaveInput) => undefined);
    useField.setState({ settings: llmSettings(), saveLlmSettings });
    render(<SystemView />);
    fireEvent.change(within(screen.getByRole("region", { name: "自定义服务" })).getByLabelText("预设"), {
      target: { value: "zhipu" },
    });
    const zhipu = screen.getByRole("region", { name: "智谱 GLM" });
    expect(within(zhipu).getByLabelText("Base URL")).toHaveValue("https://open.bigmodel.cn/api/paas/v4");
    expect(within(zhipu).getByLabelText("模型")).toHaveValue("glm-4.5");
    fireEvent.click(within(llmBlock()).getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(saveLlmSettings).toHaveBeenCalledTimes(1));
    const input = saveLlmSettings.mock.calls[0]![0]!;
    expect(input.providers).toHaveLength(2);
    expect(input.providers[1]).toMatchObject({
      id: "p-2",
      presetId: "zhipu",
      label: "智谱 GLM",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4.5",
      requiresKey: true,
    });
    expect(await within(llmBlock()).findByText(/AI 服务设置已保存（已启用 2 个提供商）/)).toBeInTheDocument();
  });

  it("保存三态 Key：留空=保留（null）、输入=写入；「清除 Key」两步确认提交空串", async () => {
    const saveLlmSettings = vi.fn(async (_input: LlmSaveInput) => undefined);
    useField.setState({ settings: llmSettings(), saveLlmSettings });
    render(<SystemView />);
    // p-2 尚未配置 Key：输入新 Key；p-1 已存 Key：留空保持。
    const second = screen.getByRole("region", { name: "自定义服务" });
    fireEvent.change(within(second).getByLabelText("API Key（尚未配置）"), { target: { value: "sk-new" } });
    fireEvent.click(within(llmBlock()).getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(saveLlmSettings).toHaveBeenCalledTimes(1));
    expect(saveLlmSettings.mock.calls[0]![0].providers.map((p) => p.apiKey)).toEqual([null, "sk-new"]);

    // 清除 p-1 的已存 Key：两步确认后立即保存，且只对该行传空串
    //（p-2 的草稿在桩动作下未被 store 回写重置，仍按写入提交）。
    const first = screen.getByRole("region", { name: "DeepSeek" });
    fireEvent.click(within(first).getByRole("button", { name: "清除 Key…" }));
    fireEvent.click(within(first).getByRole("button", { name: "确认清除 Key" }));
    await waitFor(() => expect(saveLlmSettings).toHaveBeenCalledTimes(2));
    expect(saveLlmSettings.mock.calls[1]![0].providers.map((p) => p.apiKey)).toEqual(["", "sk-new"]);
    expect(await within(llmBlock()).findByText(/已清除该提供商在本机保存的 API Key/)).toBeInTheDocument();
    expect(within(first).queryByRole("button", { name: "清除 Key…" })).not.toBeInTheDocument();
  });

  it("已存 Key 的行输入新草稿后点「测试连接」：替换也算脏，先落盘再测", async () => {
    const saveLlmSettings = vi.fn(async (_input: LlmSaveInput) => undefined);
    useField.setState({ settings: llmSettings(), saveLlmSettings });
    primeLlmBrowser();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { choices: [{ message: { content: "ok" } }] })),
    );
    render(<SystemView />);
    // p-1 已存 Key（hasKey=true）：输入新草稿是「替换」而非「保留」，
    // 不先落盘的话后端按盘上旧 Key 测试，会误报「测试通过」。
    const first = screen.getByRole("region", { name: "DeepSeek" });
    fireEvent.change(within(first).getByLabelText("API Key（已保存 · 留空保持不变）"), {
      target: { value: "sk-2" },
    });
    fireEvent.click(within(first).getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(saveLlmSettings).toHaveBeenCalledTimes(1));
    expect(saveLlmSettings.mock.calls[0]![0].providers[0]).toMatchObject({ id: "p-1", apiKey: "sk-2" });
    expect(await within(first).findByText(/连接正常 · \d+ms/)).toBeInTheDocument();
  });

  it("测试连接：成功行内显示延迟，失败显示中文可行动原因", async () => {
    useField.setState({ settings: llmSettings(), saveLlmSettings: vi.fn(async () => undefined) });
    primeLlmBrowser();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { choices: [{ message: { content: "ok" } }] }))
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: "Incorrect API key" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SystemView />);
    const first = screen.getByRole("region", { name: "DeepSeek" });
    fireEvent.click(within(first).getByRole("button", { name: "测试连接" }));
    expect(await within(first).findByText(/连接正常 · \d+ms/)).toBeInTheDocument();
    // p-2 未保存到本机镜像：直接指引先保存。
    const second = screen.getByRole("region", { name: "自定义服务" });
    fireEvent.click(within(second).getByRole("button", { name: "测试连接" }));
    expect(await within(second).findByText(/找不到该提供商配置，请先保存/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("测试连接失败（401）：行内显示鉴权失败的可行动信息", async () => {
    useField.setState({ settings: llmSettings(), saveLlmSettings: vi.fn(async () => undefined) });
    primeLlmBrowser();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: { message: "Incorrect API key" } })));
    render(<SystemView />);
    const first = screen.getByRole("region", { name: "DeepSeek" });
    fireEvent.click(within(first).getByRole("button", { name: "测试连接" }));
    expect(await within(first).findByText(/LLM 鉴权失败：请检查设置页的 API Key/)).toBeInTheDocument();
  });

  it("获取模型列表：候选 = 拉取列表 ∪ 预设推荐（去重）", async () => {
    useField.setState({ settings: llmSettings(), saveLlmSettings: vi.fn(async () => undefined) });
    primeLlmBrowser();
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        jsonResponse(200, { data: [{ id: "deepseek-coder" }, { id: "deepseek-chat" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<SystemView />);
    const first = screen.getByRole("region", { name: "DeepSeek" });
    fireEvent.click(within(first).getByRole("button", { name: "获取模型列表" }));
    expect(await within(first).findByText(/已获取 2 个模型/)).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.deepseek.com/v1/models");
    fireEvent.click(within(first).getByRole("button", { name: "展开模型列表" }));
    const options = within(within(first).getByRole("listbox", { name: "候选模型" }))
      .getAllByRole("option")
      .map((option) => option.textContent);
    // 拉取列表由 lib 侧排序（chat 在 coder 前），∪ 预设推荐去重后追加 reasoner。
    expect(options).toEqual(["deepseek-chat", "deepseek-coder", "deepseek-reasoner"]);
  });

  it("添加提供商（预设 + 自定义）：追加卡片并随保存提交", async () => {
    const saveLlmSettings = vi.fn(async (_input: LlmSaveInput) => undefined);
    useField.setState({ settings: llmSettings(), saveLlmSettings });
    render(<SystemView />);
    fireEvent.change(screen.getByLabelText("提供商预设"), { target: { value: "ollama" } });
    fireEvent.click(screen.getByRole("button", { name: "添加提供商" }));
    const ollama = screen.getByRole("region", { name: "Ollama 本地" });
    expect(within(ollama).getByLabelText("Base URL")).toHaveValue("http://localhost:11434/v1");
    expect(within(ollama).getByLabelText("API Key（免 Key 服务 · 可留空）")).toBeInTheDocument();
    // 自定义：地址与模型留空手填。
    fireEvent.change(screen.getByLabelText("提供商预设"), { target: { value: "__custom__" } });
    fireEvent.click(screen.getByRole("button", { name: "添加提供商" }));
    expect(screen.getAllByRole("region", { name: "自定义服务" })).toHaveLength(2);
    fireEvent.click(within(llmBlock()).getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(saveLlmSettings).toHaveBeenCalledTimes(1));
    const providers = saveLlmSettings.mock.calls[0]![0].providers;
    expect(providers).toHaveLength(4);
    expect(providers[2]).toMatchObject({
      presetId: "ollama",
      label: "Ollama 本地",
      baseUrl: "http://localhost:11434/v1",
      requiresKey: false,
      enabled: true,
      apiKey: null,
    });
    expect(providers[3]).toMatchObject({ presetId: null, label: "自定义服务", baseUrl: "", model: "" });
  });

  it("删除提供商：两步确认后立即保存剩余列表", async () => {
    const saveLlmSettings = vi.fn(async (_input: LlmSaveInput) => undefined);
    useField.setState({ settings: llmSettings(), saveLlmSettings });
    render(<SystemView />);
    const second = screen.getByRole("region", { name: "自定义服务" });
    fireEvent.click(within(second).getByRole("button", { name: "删除…" }));
    fireEvent.click(within(second).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(saveLlmSettings).toHaveBeenCalledTimes(1));
    expect(saveLlmSettings.mock.calls[0]![0].providers.map((p) => p.id)).toEqual(["p-1"]);
    expect(screen.queryByRole("region", { name: "自定义服务" })).not.toBeInTheDocument();
  });

  it("排序：↑↓ 立即保存新顺序，卡片顺序同步，首末按钮禁用", async () => {
    const saveLlmSettings = vi.fn(async (_input: LlmSaveInput) => undefined);
    useField.setState({ settings: llmSettings(), saveLlmSettings });
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "下移DeepSeek" }));
    await waitFor(() => expect(saveLlmSettings).toHaveBeenCalledTimes(1));
    expect(saveLlmSettings.mock.calls[0]![0].providers.map((p) => p.id)).toEqual(["p-2", "p-1"]);
    const labels = Array.from(llmBlock().querySelectorAll(".ef-provider-card")).map((card) =>
      card.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["自定义服务", "DeepSeek"]);
    expect(screen.getByRole("button", { name: "上移自定义服务" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下移DeepSeek" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "上移DeepSeek" })).toBeEnabled();
  });

  it("用量小结表：按 providerId 渲染请求 / 失败 / tokens 入出 / 最近使用", () => {
    useField.setState({ settings: llmSettings() });
    render(<SystemView />);
    const table = within(llmBlock()).getByRole("table");
    const used = within(table).getByText("DeepSeek").closest("tr")!;
    expect(used.textContent).toContain("5");
    expect(used.textContent).toContain("1");
    expect(used.textContent).toContain("1200");
    expect(used.textContent).toContain("800");
    // 最近使用按本机时区渲染「YYYY.MM.DD HH:mm」。
    const local = new Date(Date.UTC(2024, 6, 3, 9, 30));
    const hhmm = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
    expect(used.textContent).toMatch(new RegExp(`2024\\.07\\.03 ${hhmm}`));
    const unused = within(table).getByText("自定义服务").closest("tr")!;
    expect(unused.textContent).toContain("0");
    expect(unused.textContent).toContain("—");
  });
});

describe("SystemView · 运行日志面板", () => {
  beforeEach(async () => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
    await clearLog();
  });

  it("渲染种入的日志条目（最新在上）", () => {
    log.info("mineru", "解析批次开始：共 3 篇");
    log.error("ui", "导入失败：文件损坏");
    render(<SystemView />);
    const list = screen.getByRole("log", { name: "运行日志" });
    expect(within(list).getByText(/解析批次开始：共 3 篇/)).toBeInTheDocument();
    expect(within(list).getByText(/导入失败：文件损坏/)).toBeInTheDocument();
    // 最新在上：error 行在 info 行之前
    const rows = Array.from(list.querySelectorAll(".ef-log-row"));
    expect(rows[0]!.textContent).toContain("导入失败");
    expect(rows[1]!.textContent).toContain("解析批次开始");
  });

  it("级别过滤：切到「错误」只保留 error 行", () => {
    log.info("mineru", "INFO-ONLY-ROW");
    log.error("ui", "ERROR-ROW");
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "错误" }));
    const list = screen.getByRole("log", { name: "运行日志" });
    expect(within(list).getByText(/ERROR-ROW/)).toBeInTheDocument();
    expect(within(list).queryByText(/INFO-ONLY-ROW/)).not.toBeInTheDocument();
  });

  it("「清空…」两步确认：第一步只出现确认按钮且日志仍在，确认后列表清空", async () => {
    log.warn("store", "WARN-ROW");
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "清空…" }));
    // 第一步：换成确认按钮，但日志尚未清
    expect(screen.getByRole("button", { name: "确认清空" })).toBeInTheDocument();
    expect(screen.getByText(/WARN-ROW/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认清空" }));
    await waitFor(() => expect(screen.getByText("暂无日志。")).toBeInTheDocument());
  });

  it("「复制」把日志文本写入剪贴板（最新在上、一行一条）", async () => {
    log.info("app", "COPY-ROW");
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toContain("COPY-ROW");
    expect(writeText.mock.calls[0]![0]).toContain("INFO app COPY-ROW");
  });
});

describe("SystemView · 设置页顺序与 MinerU 高级项", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  it("数据导出和快捷键在运行日志之前，MinerU 连接字段默认收起", () => {
    useField.setState({ mineru: mineruState() });
    render(<SystemView />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((node) => node.textContent);
    const at = (title: string) => headings.indexOf(title);
    expect(at("AI 服务设置")).toBeGreaterThanOrEqual(0);
    expect(at("数据导出")).toBeGreaterThan(at("AI 服务设置"));
    expect(at("备份与恢复")).toBeGreaterThan(at("数据导出"));
    expect(at("快捷键")).toBeGreaterThan(at("备份与恢复"));
    expect(at("软件更新")).toBeGreaterThan(at("快捷键"));
    expect(at("MinerU 解析源")).toBeGreaterThan(at("软件更新"));
    expect(at("文献库")).toBeGreaterThan(at("MinerU 解析源"));
    expect(at("运行日志")).toBeGreaterThan(at("文献库"));
    expect(screen.queryByText("Socket 路径")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "English" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加提供商" })).toBeInTheDocument();
  });

  it("展开官方 API 的高级项后，语言是「英文」，并说明 pipeline / vlm", () => {
    useField.setState({ mineru: mineruState() });
    render(<SystemView />);
    const api = screen.getByRole("region", { name: "官方 API" });
    fireEvent.click(within(api).getByRole("button", { name: "高级" }));
    expect(within(api).getByRole("option", { name: "英文" })).toBeInTheDocument();
    expect(within(api).getByRole("option", { name: /流水线/ })).toBeInTheDocument();
    expect(within(api).getByRole("option", { name: /视觉语言模型/ })).toBeInTheDocument();
    expect(within(api).getByText(/pipeline 走通用解析流水线/)).toBeInTheDocument();
  });

  it("已配置正式公钥：桌面应用之外点检查更新只给中文说明，不报 download", async () => {
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText(/检查更新只在桌面应用里可用/)).toBeInTheDocument();
  });
});

describe("SystemView · 文献库", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
  });

  it("默认匿名，说明标题会发给文献服务，并链到申请页", () => {
    render(<SystemView />);
    expect(screen.getByRole("heading", { name: "文献库" })).toBeInTheDocument();
    expect(screen.getByText(/论文标题和 DOI 会发送到这些服务/)).toBeInTheDocument();
    expect(screen.getByText(/OpenAlex 会把请求日志保留 90 天/)).toBeInTheDocument();
    expect(screen.getAllByText("匿名").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByRole("button", { name: "openalex.org/settings/api" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "semanticscholar.org/product/api" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存文献库设置" })).toBeInTheDocument();
  });
});

describe("SystemView · 设置读取失败提示", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  it("MinerU 与文献库读取失败时各显示一条 alert，含默认值说明与错误原文", () => {
    useField.setState({
      settingsLoadError: { mineru: "MinerU 设置无法解析", biblio: "文献库设置无法解析", llm: null, secrets: null },
    });
    render(<SystemView />);
    const alerts = screen.getAllByRole("alert").map((a) => a.textContent ?? "");
    expect(alerts.some((t) => t.includes("MinerU设置文件无法读取") && t.includes("下面显示的是默认值") && t.includes("MinerU 设置无法解析"))).toBe(true);
    expect(alerts.some((t) => t.includes("文献库设置文件无法读取") && t.includes("文献库设置无法解析"))).toBe(true);
  });

  it("AI 设置和密钥文件读失败时在 AI 区域显示原文件未改写", () => {
    useField.setState({
      settingsLoadError: {
        mineru: null,
        biblio: null,
        llm: "llm-settings.json 无法读取：无法解析。原文件未改写。",
        secrets: "secrets.json 无法读取：无法解析。原文件未改写。",
      },
      settings: {
        version: 2,
        usage: {},
        providers: [
          {
            id: "p1",
            presetId: "deepseek",
            label: "DeepSeek",
            baseUrl: "https://api.deepseek.com/v1",
            model: "deepseek-chat",
            enabled: true,
            hasKey: false,
            keyState: "unreadable",
            requiresKey: true,
          },
        ],
      },
    });
    render(<SystemView />);
    expect(screen.getByText(/llm-settings.json/)).toBeInTheDocument();
    expect(screen.getByText(/secrets.json/)).toBeInTheDocument();
    expect(screen.getAllByText(/原文件未改写/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/API Key（读取失败/)).toBeInTheDocument();
    expect(screen.queryByText(/尚未配置/)).toBeNull();
  });

  it("没有读取错误时不显示该 alert", () => {
    render(<SystemView />);
    const alerts = screen.queryAllByRole("alert").map((a) => a.textContent ?? "");
    expect(alerts.filter((t) => t.includes("设置文件无法读取"))).toHaveLength(0);
  });
});
