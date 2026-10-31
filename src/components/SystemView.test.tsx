import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// 只桩掉桌面专属的备份执行函数，其余（记录读写 / 文案）保持真实实现，
// 组件与 store 动作走真路径，可断言「备份成功后写入本机记录」。
vi.mock("../lib/backup", async (orig) => ({
  ...(await orig<object>()),
  backupLibrary: vi.fn(async () => "/mock/backup/paper-field.zip"),
}));
// jsdom 没有 SQLite 引擎：pdfCount 直接拒绝，预检行与备份记录都走「读取失败降级」路径。
vi.mock("../lib/repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/repo")>();
  return { repo: { ...actual.repo, pdfCount: vi.fn(async () => { throw new Error("no engine in jsdom"); }) } };
});
import { repo } from "../lib/repo";
import { SystemView } from "./SystemView";
import * as mineruModule from "../lib/mineru";
import * as updater from "../lib/updater";
import { useField } from "../store";
import { DEFAULT_MINERU, type MineruSaveInput, type MineruSettingsV2 } from "../lib/mineru";
import { clear as clearLog, log } from "../lib/logger";
import type { ProviderHealth } from "../lib/mineru";
import type { LlmProviderView, LlmSettings, PaperListItem } from "../lib/types";
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

/** 最小可用的论文列表项（PaperListItem）。 */
function baseListItem(overrides: Partial<PaperListItem> = {}): PaperListItem {
  return {
    id: "p-1",
    domainId: "d-1",
    title: "Sample Paper",
    titleZh: null,
    abstract: "",
    year: 2023,
    venue: null,
    doi: null,
    arxivId: null,
    pdfUrl: null,
    pdfPath: null,
    codeUrl: null,
    codeOpenSource: "unknown",
    projectPage: null,
    readingStatus: "unread",
    readAt: null,
    llmPreparedAt: null,
    notesDraftedByLlm: false,
    userNotesTouched: false,
    userMetaTouched: false,
    mineruStatus: null,
    mineruParseId: null,
    mineruDocRef: null,
    mineruError: null,
    mineruParseIds: [],
    mineruProvider: null,
    mineruCredFingerprint: null,
    tags: [],
    labs: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    firstAuthor: "A",
    authorCount: 1,
    domainName: "多模态",
    domainCode: "MM-01",
    ...overrides,
  };
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

  it("五态：已启用但尚未探测时提示「尚未探测」，不再直接判不可用", () => {
    useField.setState({ mineru: mineruState(), effectiveProvider: null, mineruHealth: [], mineruProbing: false });
    render(<SystemView />);
    expect(screen.getByText(/已启用解析源，尚未探测/)).toBeInTheDocument();
    expect(screen.queryByText(/已启用的解析源均未通过探测/)).toBeNull();
  });

  it("五态：全局探测进行中（启动 / 保存触发）状态条显示探测中", () => {
    useField.setState({ mineru: mineruState(), effectiveProvider: null, mineruHealth: [], mineruProbing: true });
    render(<SystemView />);
    expect(screen.getByText("正在探测各解析源…")).toBeInTheDocument();
    expect(screen.queryByText(/尚未探测/)).toBeNull();
  });

  it("五态：显示最近一次探测时间", () => {
    const at = new Date();
    at.setHours(9, 5, 0, 0);
    useField.setState({
      mineru: mineruState(),
      effectiveProvider: "local",
      mineruProbedAt: at.getTime(),
      mineruHealth: healths([["local", true, "doclib 可达"]]),
    });
    render(<SystemView />);
    expect(screen.getByText(/上次探测 今天 09:05/)).toBeInTheDocument();
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

describe("SystemView · MinerU 一键自检与试解析引导", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("一键自检逐个测试已启用的源并汇总跳过数", async () => {
    useField.setState({ mineru: mineruState(), effectiveProvider: "local" });
    const spy = vi.spyOn(mineruModule, "testMineru").mockResolvedValue("连接正常");
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "一键自检" }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
    for (const provider of ["local", "ssh", "api"]) {
      expect(spy).toHaveBeenCalledWith(provider);
    }
    expect(await screen.findByText(/三个源都已逐个测试/)).toBeInTheDocument();
    spy.mockRestore();
  });

  it("未启用任何源：自检给配置指引而不是空转", async () => {
    useField.setState({ mineru: mineruState({ configured: false, local: { enabled: false, socketPath: "~/.mineru/doclib.sock" }, ssh: { ...DEFAULT_MINERU.ssh }, api: { ...DEFAULT_MINERU.api } }) });
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "一键自检" }));
    expect(await screen.findByText(/尚未启用任何解析源：先在下方勾选/)).toBeInTheDocument();
  });

  it("测试失败时在卡片上给出修复建议", async () => {
    useField.setState({ mineru: mineruState(), effectiveProvider: "local" });
    const spy = vi.spyOn(mineruModule, "testMineru").mockRejectedValue(new Error("Token 无效或已过期"));
    render(<SystemView />);
    const apiCard = screen.getByRole("region", { name: "官方 API" });
    fireEvent.click(within(apiCard).getByRole("button", { name: "测试连接" }));
    expect(await within(apiCard).findByText(/建议：到 mineru\.net 重新获取 Token/)).toBeInTheDocument();
    spy.mockRestore();
  });

  it("测试成功后提供「用一篇 PDF 试解析」，点击提交最早一篇", async () => {
    const saveMineruSettings = vi.fn(async (_input: MineruSaveInput, _options?: { deferJobs?: boolean }) => undefined);
    useField.setState({
      mineru: mineruState(),
      effectiveProvider: "local",
      saveMineruSettings,
      tryParseOnePaper: vi.fn(async () => undefined),
    });
    const listPendingMineru = vi.spyOn(repo, "listPendingMineru").mockResolvedValue(["p-earliest", "p-later"]);
    vi.spyOn(mineruModule, "testMineru").mockResolvedValue("连接正常");
    render(<SystemView />);
    // 与既有 deferJobs 流程一致：先改脏一个字段（测试连接会先落盘），成功后给试解析引导。
    const ssh = screen.getByRole("region", { name: "SSH 远程" });
    fireEvent.click(within(ssh).getByRole("button", { name: "高级" }));
    fireEvent.change(within(ssh).getByLabelText("主机"), { target: { value: "new-imac" } });
    fireEvent.click(within(ssh).getByRole("button", { name: "测试连接" }));
    const block = screen.getByRole("heading", { level: 3, name: "MinerU 解析源" }).closest("article") as HTMLElement;
    expect(await within(block).findByText(/未自动续跑解析/)).toBeInTheDocument();
    fireEvent.click(within(block).getByRole("button", { name: "用一篇 PDF 试解析" }));
    await waitFor(() => expect(listPendingMineru).toHaveBeenCalled());
    expect(useField.getState().tryParseOnePaper).toHaveBeenCalledTimes(1);
  });
});

describe("SystemView · 页码范围为公共设置", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  it("只启用官方 API（无本地 / SSH）时页码范围同样可见，无需展开高级项", () => {
    useField.setState({
      mineru: mineruState({
        local: { enabled: false, socketPath: "~/.mineru/doclib.sock" },
        ssh: { ...DEFAULT_MINERU.ssh, enabled: false },
      }),
      effectiveProvider: "api",
    });
    render(<SystemView />);
    expect(screen.getByLabelText("页码范围")).toBeInTheDocument();
    // 解析档位仍只在本地 / SSH 启用时出现。
    expect(screen.queryByLabelText("解析档位")).toBeNull();
  });

  it("页码范围标注各源接受的写法", () => {
    useField.setState({ mineru: mineruState(), effectiveProvider: "local" });
    render(<SystemView />);
    expect(screen.getByText(/官方 API 非 all 时随提交带上 page_ranges/)).toBeInTheDocument();
    expect(screen.getByText(/在取回全文时按该范围截取/)).toBeInTheDocument();
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
    const mineruBlock = screen.getByRole("heading", { level: 3, name: "MinerU 解析源" }).closest("article") as HTMLElement;
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
  return screen.getByRole("heading", { level: 3, name: "AI 服务设置" }).closest("article") as HTMLElement;
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

  it("「复制当前结果」把日志文本写入剪贴板（最新在上、一行一条）", async () => {
    log.info("app", "COPY-ROW");
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "复制当前结果" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toContain("COPY-ROW");
    expect(writeText.mock.calls[0]![0]).toContain("INFO app COPY-ROW");
  });

  it("关键词筛选：只保留命中的行，计数同步；复制只复制筛选结果", async () => {
    log.info("mineru", "解析批次开始：共 3 篇");
    log.error("ui", "导入失败：文件损坏");
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<SystemView />);
    fireEvent.change(screen.getByLabelText("日志关键词筛选"), { target: { value: "导入失败" } });
    const list = screen.getByRole("log", { name: "运行日志" });
    expect(within(list).getByText(/导入失败：文件损坏/)).toBeInTheDocument();
    expect(within(list).queryByText(/解析批次开始/)).not.toBeInTheDocument();
    expect(screen.getByText("1/2 条")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制当前结果" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toContain("导入失败");
    expect(writeText.mock.calls[0]![0]).not.toContain("解析批次开始");
  });

  it("模块筛选：只保留所选 scope 的行，无匹配给空态提示", () => {
    log.info("mineru", "MINERU-SCOPE-ROW");
    log.info("ui", "UI-SCOPE-ROW");
    render(<SystemView />);
    fireEvent.change(screen.getByLabelText("日志模块筛选"), { target: { value: "ui" } });
    const list = screen.getByRole("log", { name: "运行日志" });
    expect(within(list).getByText(/UI-SCOPE-ROW/)).toBeInTheDocument();
    expect(within(list).queryByText(/MINERU-SCOPE-ROW/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("日志模块筛选"), { target: { value: "engine" } });
    expect(within(screen.getByRole("log", { name: "运行日志" })).getByText("没有符合筛选条件的日志。")).toBeInTheDocument();
  });

  it("保存为文件：浏览器预览下载 txt 并提示文件名", async () => {
    log.info("app", "SAVE-FILE-ROW");
    const createObjectURL = vi.fn(() => "blob:log");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "保存为文件" }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledTimes(1));
    vi.unstubAllGlobals();
  });

  it("「复制诊断包」：版本 + 去密钥设置摘要 + 日志一次复制", async () => {
    log.info("app", "DIAG-LOG-ROW");
    useField.setState({ settings: llmSettings() });
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "复制诊断包" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0]![0];
    expect(text).toContain("# Paper Field 诊断信息");
    expect(text).toContain("DeepSeek");
    expect(text).toContain("Key 已保存");
    expect(text).toContain("DIAG-LOG-ROW");
    expect(text).toContain("浏览器预览");
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
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
    expect(at("上手清单")).toBeGreaterThanOrEqual(0);
    expect(at("AI 服务设置")).toBeGreaterThan(at("上手清单"));
    expect(at("密钥与令牌")).toBeGreaterThan(at("AI 服务设置"));
    expect(at("数据导出")).toBeGreaterThan(at("密钥与令牌"));
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

describe("SystemView · 锚点目录、查找设置与深链", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  it("锚点目录列出全部卡片，点击滚动到对应卡片并高亮为当前项", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<SystemView />);
      const nav = screen.getByRole("navigation", { name: "设置目录" });
      const titles = Array.from(nav.querySelectorAll("a")).map((a) => a.textContent);
      expect(titles).toEqual([
        "上手清单",
        "AI 服务设置",
        "密钥与令牌",
        "数据导出",
        "备份与恢复",
        "领域回收站",
        "快捷键",
        "软件更新",
        "MinerU 解析源",
        "文献库",
        "运行日志",
      ]);
      // 每张卡片都带锚点 id
      for (const id of ["setup", "llm", "secrets", "export", "backup", "domain-trash", "shortcuts", "update", "mineru", "biblio", "logs"]) {
        expect(document.getElementById(`settings-${id}`)).not.toBeNull();
      }
      fireEvent.click(within(nav).getByRole("link", { name: "备份与恢复" }));
      expect(scrollIntoView).toHaveBeenCalled();
      expect(within(nav).getByRole("link", { name: "备份与恢复" }).className).toContain("is-active");
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("查找设置：输入「备份」只保留备份卡片，其他卡片隐藏", () => {
    render(<SystemView />);
    fireEvent.change(screen.getByLabelText("查找设置"), { target: { value: "备份" } });
    expect(document.getElementById("settings-backup")).not.toBeNull();
    expect(document.getElementById("settings-shortcuts")).toBeNull();
    expect(document.getElementById("settings-llm")).toBeNull();
    // 清空恢复全部卡片
    fireEvent.change(screen.getByLabelText("查找设置"), { target: { value: "" } });
    expect(document.getElementById("settings-llm")).not.toBeNull();
    expect(document.getElementById("settings-shortcuts")).not.toBeNull();
  });

  it("查找设置：按关键词命中（「key」同时命中 AI 与文献库），无命中给出提示", () => {
    render(<SystemView />);
    fireEvent.change(screen.getByLabelText("查找设置"), { target: { value: "key" } });
    expect(document.getElementById("settings-llm")).not.toBeNull();
    expect(document.getElementById("settings-biblio")).not.toBeNull();
    expect(document.getElementById("settings-logs")).toBeNull();
    fireEvent.change(screen.getByLabelText("查找设置"), { target: { value: "不存在的词" } });
    expect(screen.getByText(/没有找到与「不存在的词」相关的设置项/)).toBeInTheDocument();
  });

  it("深链：systemFocus 滚动定位并高亮卡片，提供「返回原论文」入口", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const setMode = vi.fn(async () => undefined);
    const selectPaper = vi.fn(async () => undefined);
    useField.setState({
      mode: "system",
      systemFocus: { anchor: "mineru", returnTo: { mode: "field", paperId: "p-1" } },
      setMode,
      selectPaper,
    });
    try {
      render(<SystemView />);
      expect(scrollIntoView).toHaveBeenCalled();
      const card = document.getElementById("settings-mineru");
      expect(card?.className).toContain("is-focused");
      fireEvent.click(screen.getByRole("button", { name: /返回原论文/ }));
      await waitFor(() => expect(setMode).toHaveBeenCalledWith("field"));
      expect(selectPaper).toHaveBeenCalledWith("p-1");
      expect(useField.getState().systemFocus).toBeNull();
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("openSystemCard：从阅读模式跳设置页指定卡片，并记录返回位置", () => {
    const refresh = vi.fn(async () => undefined);
    useField.setState({ mode: "field", selectedPaperId: "p-9", refresh });
    useField.getState().openSystemCard("mineru");
    const state = useField.getState();
    expect(state.mode).toBe("system");
    expect(state.systemFocus).toEqual({ anchor: "mineru", returnTo: { mode: "field", paperId: "p-9" } });
  });

  it("快捷键说明卡：「试用」可直接触发动作（作业面板开合）", () => {
    render(<SystemView />);
    expect(useField.getState().jobsOpen).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "试用：作业面板" }));
    expect(useField.getState().jobsOpen).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "试用：作业面板" }));
    expect(useField.getState().jobsOpen).toBe(false);
  });

  it("快捷键说明卡：「试用添加论文」打开论文对话框", () => {
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "试用：添加论文（导入 PDF / 手动录入）" }));
    expect(useField.getState().dialog).toBe("paper");
  });

  it("快捷键卡列出全部快捷键并可按动作名过滤", () => {
    render(<SystemView />);
    const block = screen.getByRole("heading", { level: 3, name: "快捷键" }).closest("article") as HTMLElement;
    for (const label of [
      "在论文列表中移动",
      "标记已读",
      "搜索",
      "作业面板",
      "保存当前笔记块（在笔记编辑框内）",
      "保存当前笔记块并写下一空块（笔记编辑框内）",
      "关闭对话框 / 抽屉 / 收起笔记编辑器（保留草稿）",
    ]) {
      expect(within(block).getByText(label)).toBeInTheDocument();
    }
    for (const label of ["改键：标记已读", "改键：搜索", "改键：作业面板", "改键：添加论文（导入 PDF / 手动录入）", "改键：保存当前笔记块（在笔记编辑框内）"]) {
      expect(within(block).getByRole("button", { name: label })).toBeInTheDocument();
    }
    fireEvent.change(within(block).getByLabelText("查找快捷键"), { target: { value: "已读" } });
    expect(within(block).getByText("标记已读")).toBeInTheDocument();
    expect(within(block).queryByText("作业面板")).not.toBeInTheDocument();
    expect(within(block).queryByText("在论文列表中移动")).not.toBeInTheDocument();
  });

  it("改键：捕获新组合立即生效，冲突时拒绝并指明占用者", () => {
    render(<SystemView />);
    const block = screen.getByRole("heading", { level: 3, name: "快捷键" }).closest("article") as HTMLElement;
    fireEvent.click(within(block).getByRole("button", { name: "改键：标记已读" }));
    expect(within(block).getByText(/正在为「标记已读」改键/)).toBeInTheDocument();
    // 冲突：⌘N 已被「添加论文」占用
    fireEvent.keyDown(document.body, { key: "n", metaKey: true, bubbles: true, cancelable: true });
    expect(within(block).getByText(/「添加论文（导入 PDF \/ 手动录入）」已占用这个组合/)).toBeInTheDocument();
    expect(within(block).getByText(/正在为「标记已读」改键/)).toBeInTheDocument();
    // 合法组合：⌘M 保存成功，行内键位更新并出现「恢复默认」
    fireEvent.keyDown(document.body, { key: "m", metaKey: true, bubbles: true, cancelable: true });
    expect(within(block).queryByText(/正在为「标记已读」改键/)).not.toBeInTheDocument();
    expect(within(block).getByText("恢复默认")).toBeInTheDocument();
    const markReadRow = within(block).getByText("标记已读").closest("li")!;
    expect(markReadRow.textContent).toContain("M");
    // 恢复默认回到 R
    fireEvent.click(within(block).getByRole("button", { name: "恢复默认" }));
    const restored = within(block).getByText("标记已读").closest("li")!;
    expect(restored.textContent).toContain("R");
  });

  it("改键捕获期间 Esc 取消，纯字母提示需组合键", () => {
    render(<SystemView />);
    const block = screen.getByRole("heading", { level: 3, name: "快捷键" }).closest("article") as HTMLElement;
    fireEvent.click(within(block).getByRole("button", { name: "改键：搜索" }));
    fireEvent.keyDown(document.body, { key: "f", metaKey: false, ctrlKey: false, bubbles: true, cancelable: true });
    expect(within(block).getByText(/请按住 ⌘\/Ctrl/)).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape", bubbles: true, cancelable: true });
    expect(within(block).queryByText(/正在为「搜索」改键/)).not.toBeInTheDocument();
    expect(within(block).queryByText(/请按住/)).not.toBeInTheDocument();
  });
});

describe("SystemView · 数据导出（范围与内容选择）", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  function exportBlock(): HTMLElement {
    return screen.getByRole("heading", { level: 3, name: "数据导出" }).closest("article") as HTMLElement;
  }

  it("默认当前领域 + 笔记摘要，预览显示当前领域论文数", () => {
    useField.setState({
      domains: [{ id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" }],
      selectedDomainId: "d-1",
      papers: [
        { ...baseListItem(), id: "p-1" },
        { ...baseListItem(), id: "p-2" },
      ],
      stats: { read: 5, total: 9, openSource: 0, queued: 0, running: 0 },
    });
    render(<SystemView />);
    const block = exportBlock();
    expect(within(block).getByLabelText("导出范围")).toHaveValue("current");
    expect(within(block).getByText(/将导出/).textContent).toContain("2");
    expect(within(block).getByText(/将导出/).textContent).toContain("现场笔记、摘要");
    expect(within(block).getByRole("button", { name: /导出 多模态/ })).toBeEnabled();
  });

  it("切换范围到仅已读：预览改用已读数，按钮禁用当计数为 0", () => {
    const exportPapers = vi.fn(async () => undefined);
    useField.setState({ stats: { read: 3, total: 9, openSource: 0, queued: 0, running: 0 }, exportPapers });
    render(<SystemView />);
    const block = exportBlock();
    fireEvent.change(within(block).getByLabelText("导出范围"), { target: { value: "read" } });
    expect(within(block).getByText(/将导出/).textContent).toContain("3");
    // 关掉笔记与摘要后点导出：提交的范围与内容选择完整传给 store
    fireEvent.click(within(block).getByRole("checkbox", { name: "现场笔记" }));
    fireEvent.click(within(block).getByRole("checkbox", { name: "摘要" }));
    fireEvent.click(within(block).getByRole("button", { name: /^导出$/ }));
    expect(exportPapers).toHaveBeenCalledWith({
      scope: "read",
      format: "folders",
      include: { notes: false, abstract: false, parsedText: false },
    });
    // 勾选集为空时预览为 0，按钮禁用
    fireEvent.change(within(block).getByLabelText("导出范围"), { target: { value: "checked" } });
    expect(within(block).getByText(/将导出/).textContent).toContain("0");
    expect(within(block).getByRole("button", { name: /^导出$/ })).toBeDisabled();
  });

  it("勾选集范围使用勾选数并随勾选变化", () => {
    useField.setState({ checkedPaperIds: ["p-1", "p-2", "p-3"], exportPapers: vi.fn(async () => undefined) });
    render(<SystemView />);
    const block = exportBlock();
    fireEvent.change(within(block).getByLabelText("导出范围"), { target: { value: "checked" } });
    expect(within(block).getByText(/将导出/).textContent).toContain("3");
  });

  it("格式选择：BibTeX 隐藏内容选择并说明只含著录信息，随导出提交格式", () => {
    const exportPapers = vi.fn(async () => undefined);
    useField.setState({ stats: { read: 2, total: 5, openSource: 0, queued: 0, running: 0 }, exportPapers });
    render(<SystemView />);
    const block = exportBlock();
    expect(within(block).getByLabelText("导出格式")).toHaveValue("folders");
    expect(within(block).getByRole("checkbox", { name: "现场笔记" })).toBeInTheDocument();
    fireEvent.change(within(block).getByLabelText("导出格式"), { target: { value: "bibtex" } });
    expect(within(block).queryByRole("checkbox", { name: "现场笔记" })).not.toBeInTheDocument();
    expect(within(block).getByText(/只包含著录信息/)).toBeInTheDocument();
    fireEvent.change(within(block).getByLabelText("导出范围"), { target: { value: "read" } });
    expect(within(block).getByText(/将导出/).textContent).toContain("条 BibTeX 条目");
    fireEvent.click(within(block).getByRole("button", { name: /^导出$/ }));
    expect(exportPapers).toHaveBeenCalledWith({
      scope: "read",
      format: "bibtex",
      include: { notes: true, abstract: true, parsedText: false },
    });
  });

  it("格式选择：合并版随导出提交 merged", () => {
    const exportPapers = vi.fn(async () => undefined);
    useField.setState({ stats: { read: 0, total: 4, openSource: 0, queued: 0, running: 0 }, exportPapers });
    render(<SystemView />);
    const block = exportBlock();
    fireEvent.change(within(block).getByLabelText("导出格式"), { target: { value: "merged" } });
    fireEvent.change(within(block).getByLabelText("导出范围"), { target: { value: "all" } });
    fireEvent.click(within(block).getByRole("button", { name: /^导出$/ }));
    expect(exportPapers).toHaveBeenCalledWith({
      scope: "all",
      format: "merged",
      include: { notes: true, abstract: true, parsedText: false },
    });
  });
});

describe("SystemView · 上手清单（最小可用配置）", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  it("全新空库：核心两项待完成并给出去配置入口，可选项标注可选", () => {
    render(<SystemView />);
    const block = screen.getByRole("article", { name: "上手清单" });
    expect(within(block).getByText("研究领域")).toBeInTheDocument();
    expect(within(block).getByText(/先建一个领域/)).toBeInTheDocument();
    expect(within(block).getByText(/导入 PDF 或手动录入第一篇论文/)).toBeInTheDocument();
    expect(within(block).getAllByText("待完成")).toHaveLength(2);
    expect(within(block).getAllByText("可选")).toHaveLength(3);
    expect(within(block).getByText(/进度：/).textContent).toContain("0");
    expect(within(block).getByText(/没有配置的部分不影响手动录入与阅读/)).toBeInTheDocument();
  });

  it("已配置解析源与 AI：状态显示生效来源，进度按实际计数", () => {
    useField.setState({
      mineru: mineruState(),
      effectiveProvider: "local",
      settings: llmSettings(),
    });
    render(<SystemView />);
    const block = screen.getByRole("article", { name: "上手清单" });
    expect(within(block).getByText(/已启用，生效来源：本地 CLI/)).toBeInTheDocument();
    expect(within(block).getByText(/已配置，可补全论文信息与起草笔记/)).toBeInTheDocument();
    expect(within(block).getByText(/进度：/).textContent).toContain("2");
  });

  it("「去配置」跳到对应卡片，「去创建领域」打开领域对话框", () => {
    const openSystemCard = vi.fn();
    const openDialog = vi.fn();
    useField.setState({ openSystemCard, openDialog });
    render(<SystemView />);
    const block = screen.getByRole("article", { name: "上手清单" });
    fireEvent.click(within(block).getByRole("button", { name: "去创建领域" }));
    expect(openDialog).toHaveBeenCalledWith("domain");
    // 解析源 / AI / 文献库三项的「去配置」都经 openSystemCard 跳卡
    const goButtons = within(block).getAllByRole("button", { name: "去配置" });
    for (const button of goButtons) fireEvent.click(button);
    expect(openSystemCard).toHaveBeenCalledWith("mineru");
    expect(openSystemCard).toHaveBeenCalledWith("llm");
    expect(openSystemCard).toHaveBeenCalledWith("biblio");
  });

  it("「去导入论文」先切回阅读模式再打开论文对话框", async () => {
    const setMode = vi.fn(async () => undefined);
    const openDialog = vi.fn();
    useField.setState({ setMode, openDialog });
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "去导入论文" }));
    await waitFor(() => expect(setMode).toHaveBeenCalledWith("field"));
    expect(openDialog).toHaveBeenCalledWith("paper");
  });
});

describe("SystemView · 备份状态与预检", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  function backupBlock(): HTMLElement {
    return screen.getByRole("heading", { level: 3, name: "备份与恢复" }).closest("article") as HTMLElement;
  }

  it("无记录时提示从未备份，并显示预检清单（论文数来自统计）", () => {
    useField.setState({ stats: { read: 1, total: 6, openSource: 0, queued: 0, running: 0 } });
    render(<SystemView />);
    const block = backupBlock();
    expect(within(block).getByText(/本机还没有成功备份的记录/)).toBeInTheDocument();
    expect(within(block).getByText(/本次将打包/).textContent).toContain("6");
    expect(within(block).getByText(/本次将打包/).textContent).toContain("—");
  });

  it("有记录时显示上次备份时间、规模、位置与距今天数；超过 7 天给过期提醒", () => {
    const at = Date.now() - 10 * 86400_000;
    localStorage.setItem(
      "paper-field.last-backup",
      JSON.stringify({ at, where: "/Volumes/bak/paper-field.zip", papers: 5, pdfs: 4 }),
    );
    render(<SystemView />);
    const block = backupBlock();
    const status = within(block).getByText(/上次备份/);
    expect(status.textContent).toContain("共 5 篇");
    expect(status.textContent).toContain("/Volumes/bak/paper-field.zip");
    expect(status.textContent).toContain("10 天");
    expect(status.textContent).toContain("已超过 7 天，建议再备份一次");
  });

  it("备份成功后写入本机记录（桌面端路径；状态行下次进入设置页可见）", async () => {
    useField.setState({ stats: { read: 0, total: 2, openSource: 0, queued: 0, running: 0 } });
    // 备份按钮在浏览器预览禁用；这里直接走 store 动作验证「成功后写记录」。
    await useField.getState().backupLibrary();
    const raw = localStorage.getItem("paper-field.last-backup");
    expect(raw).toBeTruthy();
    const record = JSON.parse(raw!) as { where: string; papers: number };
    expect(record.where).toBe("/mock/backup/paper-field.zip");
    expect(record.papers).toBe(2);
  });
});

describe("SystemView · 未保存修改拦截与草稿保留", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  /** 把某块表单改脏（改自定义服务的 Base URL）。 */
  function dirtyLlmForm() {
    fireEvent.change(within(screen.getByRole("region", { name: "自定义服务" })).getByLabelText("Base URL"), {
      target: { value: "https://changed.example/v1" },
    });
  }

  it("修改表单出现「未保存」标记", () => {
    useField.setState({ settings: llmSettings() });
    render(<SystemView />);
    const block = llmBlock();
    expect(within(block).queryByText("未保存")).not.toBeInTheDocument();
    dirtyLlmForm();
    expect(within(block).getByText("未保存")).toBeInTheDocument();
  });

  it("有未保存修改时 setMode 被拦下并弹三选；「留在此页」取消切换", async () => {
    useField.setState({
      mode: "system",
      refresh: vi.fn(async () => undefined),
      settings: llmSettings(),
      saveLlmSettings: vi.fn(async () => undefined),
    });
    render(<SystemView />);
    dirtyLlmForm();
    await act(async () => {
      await useField.getState().setMode("field");
    });
    // 未切换：记录目标模式，弹三选
    expect(useField.getState().mode).toBe("system");
    expect(useField.getState().pendingMode).toBe("field");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("设置页有未保存的修改")).toBeInTheDocument();
    expect(within(dialog).getByText("AI 服务设置")).toBeInTheDocument();
    for (const label of ["保存修改并离开", "放弃修改并离开", "留在此页"]) {
      expect(within(dialog).getByRole("button", { name: label })).toBeInTheDocument();
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "留在此页" }));
    expect(useField.getState().pendingMode).toBeNull();
    expect(useField.getState().mode).toBe("system");
  });

  it("「保存修改并离开」先保存再切换；「放弃修改并离开」清草稿并切换", async () => {
    const saveLlmSettings = vi.fn(async () => undefined);
    useField.setState({
      mode: "system",
      refresh: vi.fn(async () => undefined),
      settings: llmSettings(),
      saveLlmSettings,
    });
    const { unmount } = render(<SystemView />);
    dirtyLlmForm();
    // dirty 时草稿已写盘（不含 Key）
    expect(localStorage.getItem("paper-field.settings-draft.llm")).not.toContain("sk-");
    await act(async () => {
      await useField.getState().setMode("archive");
    });
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存修改并离开" }));
    await waitFor(() => expect(saveLlmSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useField.getState().mode).toBe("archive"));
    unmount();

    // 放弃路径：改脏 → 拦下 → 放弃 → 模式切换且草稿键被清
    useField.setState({ mode: "system", pendingMode: null, settings: llmSettings() });
    render(<SystemView />);
    dirtyLlmForm();
    await act(async () => {
      await useField.getState().setMode("intake");
    });
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "放弃修改并离开" }));
    await waitFor(() => expect(useField.getState().mode).toBe("intake"));
    expect(localStorage.getItem("paper-field.settings-draft.llm")).toBeNull();
  });

  it("未保存的非敏感草稿在本机保留，回到设置页可恢复或丢弃", () => {
    useField.setState({ settings: llmSettings() });
    const { unmount } = render(<SystemView />);
    fireEvent.change(within(screen.getByRole("region", { name: "自定义服务" })).getByLabelText("Base URL"), {
      target: { value: "https://draft.example/v1" },
    });
    unmount();
    // 重新进入设置页：草稿恢复（不含 Key），可一键丢弃
    render(<SystemView />);
    expect(screen.getByText(/已恢复上次未保存的草稿（不含 API Key）/)).toBeInTheDocument();
    const row = screen.getByRole("region", { name: "自定义服务" });
    expect(within(row).getByLabelText("Base URL")).toHaveValue("https://draft.example/v1");
    fireEvent.click(screen.getByRole("button", { name: "丢弃草稿" }));
    expect(within(screen.getByRole("region", { name: "自定义服务" })).getByLabelText("Base URL")).toHaveValue(
      "https://my-proxy.example/v1",
    );
    expect(localStorage.getItem("paper-field.settings-draft.llm")).toBeNull();
  });

  it("MinerU 与文献库表单也注册守卫：改脏后离开被拦下", async () => {
    useField.setState({
      mode: "system",
      refresh: vi.fn(async () => undefined),
      mineru: mineruState(),
      saveMineruSettings: vi.fn(async () => undefined),
    });
    render(<SystemView />);
    // 改 SSH 主机 → 脏
    const ssh = screen.getByRole("region", { name: "SSH 远程" });
    fireEvent.click(within(ssh).getByRole("button", { name: "高级" }));
    fireEvent.change(within(ssh).getByLabelText("主机"), { target: { value: "new-host" } });
    await act(async () => {
      await useField.getState().setMode("field");
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("MinerU 解析源")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "留在此页" }));
    expect(useField.getState().mode).toBe("system");
  });

  it("已保存 Token 但输入框留空时不算脏（不误报未保存）", () => {
    useField.setState({ mineru: mineruState() });
    render(<SystemView />);
    const block = screen.getByRole("heading", { level: 3, name: "MinerU 解析源" }).closest("article") as HTMLElement;
    expect(within(block).queryByText("未保存")).not.toBeInTheDocument();
  });
});

describe("SystemView · 软件更新（版本预览 / 下载 / 稍后）", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  it("已是最新版本时只显示提示，不出现下载按钮", async () => {
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText(/检查更新只在桌面应用里可用/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "立即下载并重启" })).not.toBeInTheDocument();
  });

  it("发现新版本：预览版本与说明、提示运行中作业与草稿，稍后可关闭", async () => {
    const downloadAndInstall = vi.fn(async () => undefined);
    vi.spyOn(updater, "checkAppUpdateInfo").mockResolvedValue({
      status: "available",
      message: "发现新版本 0.3.0。",
      version: "0.3.0",
      date: "2026-10-20T00:00:00Z",
      notes: "## 更新内容\n- 修复了若干问题",
      update: { downloadAndInstall },
    });
    useField.setState({
      jobs: [
        { id: "j-1", paperId: "p-1", type: "mineruParse", status: "running", prompt: null, resultJson: null, error: null, createdAt: "", startedAt: "", finishedAt: null },
      ],
      drafts: { "p-1": { summary: "草稿" } },
    });
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText(/发现新版本/)).toBeInTheDocument();
    expect(screen.getByText("0.3.0")).toBeInTheDocument();
    expect(screen.getByText(/有 1 个作业正在运行/)).toBeInTheDocument();
    expect(screen.getByText(/1 篇论文的笔记草稿尚未保存/)).toBeInTheDocument();
    const notes = screen.getByText("版本说明").parentElement as HTMLElement;
    expect(notes.textContent).toContain("修复了若干问题");
    expect(downloadAndInstall).not.toHaveBeenCalled();
    // 稍后再说：收起预览，回到检查按钮，不下载
    fireEvent.click(screen.getByRole("button", { name: "稍后再说" }));
    expect(screen.getByRole("button", { name: "检查更新" })).toBeInTheDocument();
    expect(downloadAndInstall).not.toHaveBeenCalled();
  });

  it("「立即下载并重启」才真正下载安装", async () => {
    const downloadAndInstall = vi.fn(async () => undefined);
    vi.spyOn(updater, "checkAppUpdateInfo").mockResolvedValue({
      status: "available",
      message: "发现新版本 0.3.0。",
      version: "0.3.0",
      notes: "说明",
      update: { downloadAndInstall },
    });
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    await screen.findByText(/发现新版本/);
    fireEvent.click(screen.getByRole("button", { name: "立即下载并重启" }));
    await waitFor(() => expect(downloadAndInstall).toHaveBeenCalledTimes(1));
  });

  it("安装失败给出中文提示且不丢数据说明", async () => {
    vi.spyOn(updater, "checkAppUpdateInfo").mockResolvedValue({
      status: "available",
      message: "发现新版本 0.3.0。",
      version: "0.3.0",
      update: {
        downloadAndInstall: async () => {
          throw new Error("signature invalid");
        },
      },
    });
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    await screen.findByText(/发现新版本/);
    fireEvent.click(screen.getByRole("button", { name: "立即下载并重启" }));
    expect(await screen.findByText(/安装更新失败：signature invalid。笔记数据不受影响/)).toBeInTheDocument();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

describe("SystemView · 测试连接与启用自动处理分离", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("AI 测试连接：脏表单按 deferBackfill 落盘，成功后提供显式「启用自动补全」", async () => {
    const saveLlmSettings = vi.fn(async (_input: LlmSaveInput, _options?: { deferBackfill?: boolean }) => undefined);
    const startMetaBackfill = vi.fn(async () => 3);
    useField.setState({ settings: llmSettings(), saveLlmSettings, startMetaBackfill });
    primeLlmBrowser();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { choices: [{ message: { content: "ok" } }] })),
    );
    render(<SystemView />);
    const first = screen.getByRole("region", { name: "DeepSeek" });
    fireEvent.change(within(first).getByLabelText("Base URL"), { target: { value: "https://api2.deepseek.com/v1" } });
    fireEvent.click(within(first).getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(saveLlmSettings).toHaveBeenCalledTimes(1));
    expect(saveLlmSettings.mock.calls[0]![1]).toEqual({ deferBackfill: true });
    expect(await within(llmBlock()).findByText(/自动补全暂未启动/)).toBeInTheDocument();
    fireEvent.click(within(llmBlock()).getByRole("button", { name: "启用自动补全" }));
    await waitFor(() => expect(startMetaBackfill).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(llmBlock()).queryByText(/自动补全暂未启动/)).not.toBeInTheDocument());
  });

  it("AI 测试连接：表单不脏时不保存也不出现启用入口", async () => {
    const saveLlmSettings = vi.fn(async () => undefined);
    useField.setState({ settings: llmSettings(), saveLlmSettings });
    primeLlmBrowser();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { choices: [{ message: { content: "ok" } }] })),
    );
    render(<SystemView />);
    fireEvent.click(within(screen.getByRole("region", { name: "DeepSeek" })).getByRole("button", { name: "测试连接" }));
    await waitFor(() =>
      expect(within(screen.getByRole("region", { name: "DeepSeek" })).getByText(/连接正常/)).toBeInTheDocument(),
    );
    expect(saveLlmSettings).not.toHaveBeenCalled();
    expect(within(llmBlock()).queryByText(/自动补全暂未启动/)).not.toBeInTheDocument();
  });

  it("MinerU 测试连接：脏表单按 deferJobs 落盘，成功后提供显式「继续未完成的解析」", async () => {
    const saveMineruSettings = vi.fn(async (_input: MineruSaveInput, _options?: { deferJobs?: boolean }) => undefined);
    const resumeMineruParses = vi.fn(async () => 2);
    useField.setState({ mineru: mineruState(), effectiveProvider: null, saveMineruSettings, resumeMineruParses });
    vi.spyOn(mineruModule, "testMineru").mockResolvedValue("连接正常");
    render(<SystemView />);
    const ssh = screen.getByRole("region", { name: "SSH 远程" });
    fireEvent.click(within(ssh).getByRole("button", { name: "高级" }));
    fireEvent.change(within(ssh).getByLabelText("主机"), { target: { value: "new-imac" } });
    fireEvent.click(within(ssh).getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(saveMineruSettings).toHaveBeenCalledTimes(1));
    expect(saveMineruSettings.mock.calls[0]![1]).toEqual({ deferJobs: true });
    const block = screen.getByRole("heading", { level: 3, name: "MinerU 解析源" }).closest("article") as HTMLElement;
    expect(await within(block).findByText(/未自动续跑解析/)).toBeInTheDocument();
    fireEvent.click(within(block).getByRole("button", { name: "继续未完成的解析" }));
    await waitFor(() => expect(resumeMineruParses).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(block).queryByText(/未自动续跑解析/)).not.toBeInTheDocument());
  });
});

describe("SystemView · 浏览器预览的桌面专属能力标注", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  it("顶部显示浏览器预览说明，指明桌面专属能力与替代动作", () => {
    render(<SystemView />);
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("浏览器预览模式");
    expect(note.textContent).toContain("备份 / 恢复、检查更新、MinerU 连接");
    expect(note.textContent).toContain("数据导出");
    expect(note.textContent).toContain("GitHub Releases");
  });

  it("备份 / 恢复按钮禁用并给出可见原因（不再点了才弹警告）", () => {
    render(<SystemView />);
    const block = screen.getByRole("heading", { level: 3, name: "备份与恢复" }).closest("article") as HTMLElement;
    expect(within(block).getByRole("button", { name: "备份" })).toBeDisabled();
    expect(within(block).getByRole("button", { name: "恢复" })).toBeDisabled();
    expect(within(block).getByText(/浏览器预览不能备份 \/ 恢复/)).toBeInTheDocument();
  });
});

describe("SystemView · 统一保存规则标注", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  it("三块表单与导出卡都标注了生效规则（立即生效项 vs 等保存）", () => {
    render(<SystemView />);
    const llm = llmBlock();
    expect(within(llm).getByText(/字段修改需点「保存设置」；提供商排序 ↑↓、测试连接、获取模型列表与清除 Key 立即生效/)).toBeInTheDocument();
    const mineru = screen.getByRole("heading", { level: 3, name: "MinerU 解析源" }).closest("article") as HTMLElement;
    expect(within(mineru).getByText(/字段修改需点「保存设置」；回退顺序调整、测试连接与清除 Token 立即生效/)).toBeInTheDocument();
    const biblio = screen.getByRole("heading", { level: 3, name: "文献库" }).closest("article") as HTMLElement;
    expect(within(biblio).getByText(/邮箱与 Key 的修改均需点「保存文献库设置」后生效/)).toBeInTheDocument();
    const exportCard = screen.getByRole("heading", { level: 3, name: "数据导出" }).closest("article") as HTMLElement;
    expect(within(exportCard).getByText(/导出立即执行，只读不改动库内数据/)).toBeInTheDocument();
    const secrets = screen.getByRole("article", { name: "密钥与令牌" });
    expect(within(secrets).getByText(/清除立即生效/)).toBeInTheDocument();
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

describe("自动补全开关与待处理篇数预览", () => {
  it("显示开关与待补全篇数；切换写进本机记忆", async () => {
    localStorage.removeItem("paper-field.auto-backfill");
    const listReady = vi.spyOn(repo, "listReadyForMeta").mockResolvedValue(["p1", "p2", "p3"]);
    // 配置可用（hasKey 的启用提供商）时开关行显示篇数预览与自动排队说明。
    useField.setState({
      settings: {
        version: 2,
        usage: {},
        providers: [llmProviderViews()[0]!],
      },
    });
    render(<SystemView />);
    const checkbox = await screen.findByRole("checkbox", { name: "自动补全旧论文" });
    expect(checkbox).toBeChecked();
    const info = await screen.findByText(/当前待补全/);
    expect(info.textContent).toContain("3 篇");

    fireEvent.click(checkbox);
    expect(localStorage.getItem("paper-field.auto-backfill")).toBe("0");
    expect(screen.getByText(/关闭后仍可单篇/)).toBeInTheDocument();

    fireEvent.click(checkbox);
    expect(localStorage.getItem("paper-field.auto-backfill")).toBeNull();
    listReady.mockRestore?.();
  });

  it("篇数读不到时显示省略号占位，不阻塞开关", async () => {
    localStorage.setItem("paper-field.auto-backfill", "0");
    const listReady = vi.spyOn(repo, "listReadyForMeta").mockRejectedValue(new Error("no engine"));
    useField.setState({
      settings: {
        version: 2,
        usage: {},
        providers: [llmProviderViews()[0]!],
      },
    });
    render(<SystemView />);
    const checkbox = await screen.findByRole("checkbox", { name: "自动补全旧论文" });
    expect(checkbox).not.toBeChecked();
    const info = await screen.findByText(/当前待补全/);
    expect(info.textContent).toContain("… 篇");
    localStorage.removeItem("paper-field.auto-backfill");
    listReady.mockRestore?.();
  });
});

describe("任务模型分配（元数据/笔记分别选模型）", () => {
  it("为两类任务分别选择首选模型并写进本机记忆；可恢复跟随全局", async () => {
    localStorage.removeItem("paper-field.task-primary.meta");
    localStorage.removeItem("paper-field.task-primary.notes");
    useField.setState({
      settings: {
        version: 2,
        usage: {},
        providers: [
          { id: "p-1", presetId: "deepseek", label: "DeepSeek", baseUrl: "u", model: "m1", enabled: true, hasKey: true, requiresKey: true },
          { id: "p-2", presetId: null, label: "Kimi", baseUrl: "u", model: "m2", enabled: true, hasKey: true, requiresKey: true },
        ],
      },
    });
    render(<SystemView />);
    const metaSelect = screen.getByLabelText("补全论文信息首选模型");
    const notesSelect = screen.getByLabelText("起草阅读笔记首选模型");
    expect(metaSelect).toHaveValue("");
    fireEvent.change(metaSelect, { target: { value: "p-2" } });
    fireEvent.change(notesSelect, { target: { value: "p-1" } });
    expect(localStorage.getItem("paper-field.task-primary.meta")).toBe("p-2");
    expect(localStorage.getItem("paper-field.task-primary.notes")).toBe("p-1");
    // 恢复跟随全局。
    fireEvent.change(metaSelect, { target: { value: "" } });
    expect(localStorage.getItem("paper-field.task-primary.meta")).toBeNull();
    localStorage.removeItem("paper-field.task-primary.notes");
  });
});
