// 第 1 轮集成与回归检测：通知（toasts）× 运行日志（logger）两模块的联动，
// 关键任务节点（导入 / MinerU 解析与补全 / 导出 / 领域管理 / 设置保存 / 持久化异常）
// 的通知触达，以及两项改动未破坏既有行为的回归基线。
// 既有单测已分段覆盖各层（store.test / Toasts.test / logger.test / mineruRun.test /
// SystemView.test），本文件只做跨层链路，不重复段内行为。
//
// 产品侧 sink 注入点在 main.tsx（测试环境不经 main），沿用 store.test.ts 的先例
// 在此复刻同一映射规则：emit 按 tone 映射级别（ok→info / warn→warn / error→error）、
// dismiss / evict 记 info（发出与关闭都留痕）、refresh 记 debug（高频去重不刷日志）。
import { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

// 本文件直接用 react 的 act 包裹组件外的 store 更新（notify / setFlash），
// 需显式声明 act 环境（与 Toasts.test.tsx 相同）。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./lib/repo", () => ({
  repo: {
    init: vi.fn(async () => undefined),
    getPaper: vi.fn(async () => null),
    getDomain: vi.fn(async () => null),
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    listFailedMineru: vi.fn(async () => [] as string[]),
    listPendingMineru: vi.fn(async () => [] as string[]),
    listReadyForMeta: vi.fn(async () => [] as string[]),
    importLocalPdfs: vi.fn(),
    createJob: vi.fn(async () => ({ id: "job-1", status: "queued" })),
    updateJob: vi.fn(async () => undefined),
    setMineruState: vi.fn(async () => undefined),
    saveParsedMarkdown: vi.fn(async () => undefined),
    applyPreparedMeta: vi.fn(async () => undefined),
    papersForExport: vi.fn(async () => []),
    deleteDomain: vi.fn(async () => undefined),
    createDomain: vi.fn(),
  },
}));

// MinerU 网络函数打桩（保留常量与类型相关实现）；settings / export 同理只桩 IO 边界。
vi.mock("./lib/mineru", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/mineru")>();
  return {
    ...actual,
    loadMineruSettings: vi.fn(async () => actual.DEFAULT_MINERU),
    saveMineruSettings: vi.fn(async () => actual.DEFAULT_MINERU),
    mineruProbe: vi.fn(async () => []),
    mineruSubmit: vi.fn(),
    mineruParseStatuses: vi.fn(),
    mineruMarkdown: vi.fn(),
  };
});

vi.mock("./lib/settings", () => ({
  loadSettings: vi.fn(async () => ({
    version: 2,
    providers: [],
    usage: {},
  })),
  saveSettings: vi.fn(async () => ({ version: 2, providers: [], usage: {} })),
  completeChat: vi.fn(async () => '{"title":"补全标题"}'),
  cancelChat: vi.fn(async () => undefined),
  // 门禁派生口径（与真实实现同义）：任一 enabled 且（requiresKey ? hasKey : 免 Key）。
  hasUsableProvider: (settings: { providers: Array<{ enabled: boolean; requiresKey: boolean; hasKey: boolean }> }) =>
    settings.providers.some((provider) => provider.enabled && (!provider.requiresKey || provider.hasKey)),
}));

vi.mock("./lib/export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/export")>();
  return { ...actual, exportDomain: vi.fn() };
});

// plugin-store 统一替换为内存假 store：隔离 IPC 并提供落盘行为断言（logger.test.ts 先例）。
const fakeStore = vi.hoisted(() => ({
  set: vi.fn(async (_key: string, _value: unknown) => undefined),
  get: vi.fn(async (_key?: string) => undefined as unknown),
  clear: vi.fn(async () => undefined),
  save: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async (_path: string, _options?: unknown) => fakeStore),
}));

// isTauri 按用例切换（默认 false = 浏览器 / jsdom 分支），其余 util 保持原实现。
vi.mock("./lib/util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/util")>();
  return { ...actual, isTauri: vi.fn(() => false) };
});

import { DEFAULT_MINERU, mineruMarkdown, mineruProbe, mineruSubmit, saveMineruSettings as saveMineru } from "./lib/mineru";
import { loadSettings, saveSettings } from "./lib/settings";
import { exportDomain } from "./lib/export";
import { isTauri } from "./lib/util";
import { clear as clearLog, getEntries, log } from "./lib/logger";
import { load as storeLoad } from "@tauri-apps/plugin-store";
import { repo } from "./lib/repo";
import { bindToastLog, dismissAll, getToasts, type ToastLogEvent } from "./toasts";
import { useField } from "./store";
import { LogPanel } from "./components/LogPanel";
import type { Domain, LlmJob, Paper, PaperDetail, PaperListItem } from "./lib/types";

const appSource = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");

function listItem(id: string): PaperListItem {
  return {
    id,
    domainId: "d-1",
    title: `论文 ${id}`,
    titleZh: null,
    abstract: "",
    year: null,
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
    firstAuthor: null,
    authorCount: 0,
    domainName: "多模态",
    domainCode: "MM-01",
  };
}

function detailOf(id: string, overrides: Partial<PaperDetail> = {}): PaperDetail {
  return {
    ...listItem(id),
    authors: [],
    notes: {} as PaperDetail["notes"],
    domain: {} as PaperDetail["domain"],
    parsedMarkdown: "",
    ...overrides,
  };
}

function domainOf(id: string): Domain {
  return {
    id,
    name: "多模态",
    code: "MM-01",
    summary: null,
    sortOrder: 1,
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

/** 与 main.tsx 的 toastEventToLog 同规则的 sink（产品侧唯一注入点在 main.tsx）。 */
function bindMainLikeSink(): void {
  bindToastLog((event: ToastLogEvent) => {
    if (event.action === "emit") {
      if (event.tone === "error") log.error("ui", event.text);
      else if (event.tone === "warn") log.warn("ui", event.text);
      else log.info("ui", event.text);
      return;
    }
    if (event.action === "refresh") {
      log.debug("ui", `通知刷新停留计时：${event.text}`);
      return;
    }
    if (event.action === "evict") {
      log.info("ui", `通知超出堆叠上限被逐出：${event.text}`);
      return;
    }
    log.info("ui", `通知关闭（${event.reason === "auto" ? "自动消退" : "手动关闭"}）：${event.text}`);
  });
}

/** 静音控制台镜像（通知链路每条都会镜像 console），用例输出不被刷屏。 */
function quietConsole() {
  return (["debug", "log", "warn", "error"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
}

let quiet: ReturnType<typeof quietConsole> = [];

beforeEach(async () => {
  quiet = quietConsole();
  vi.mocked(isTauri).mockReturnValue(false);
  useField.setState(useField.getInitialState(), true);
  act(() => {
    bindToastLog(null);
    dismissAll("manual");
  });
  await clearLog();
  bindMainLikeSink();
  // mock 状态跨用例重置（实现 + 调用记录），默认值与工厂一致；mineruRun.test.ts 先例。
  vi.mocked(repo.init).mockReset().mockResolvedValue(undefined);
  vi.mocked(repo.getPaper).mockReset().mockImplementation(async () => null);
  vi.mocked(repo.getDomain).mockReset().mockImplementation(async () => null);
  vi.mocked(repo.stats).mockReset().mockResolvedValue({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 });
  vi.mocked(repo.listJobs).mockReset().mockResolvedValue([]);
  vi.mocked(repo.listDomains).mockReset().mockResolvedValue([]);
  vi.mocked(repo.listPapers).mockReset().mockResolvedValue([]);
  vi.mocked(repo.listArchive).mockReset().mockResolvedValue([]);
  vi.mocked(repo.listIntake).mockReset().mockResolvedValue([]);
  vi.mocked(repo.listFailedMineru).mockReset().mockResolvedValue([]);
  vi.mocked(repo.listPendingMineru).mockReset().mockResolvedValue([]);
  vi.mocked(repo.listReadyForMeta).mockReset().mockResolvedValue([]);
  vi.mocked(repo.importLocalPdfs).mockReset();
  vi.mocked(repo.createJob).mockReset().mockResolvedValue({ id: "job-1", status: "queued" } as LlmJob);
  vi.mocked(repo.updateJob).mockReset().mockResolvedValue(true);
  vi.mocked(repo.setMineruState).mockReset().mockResolvedValue(true);
  vi.mocked(repo.saveParsedMarkdown).mockReset().mockResolvedValue(undefined);
  vi.mocked(repo.applyPreparedMeta).mockReset().mockResolvedValue(undefined);
  vi.mocked(repo.papersForExport).mockReset().mockResolvedValue([]);
  vi.mocked(repo.deleteDomain).mockReset().mockResolvedValue(undefined);
  vi.mocked(repo.createDomain).mockReset();
  vi.mocked(saveMineru).mockReset().mockResolvedValue(DEFAULT_MINERU);
  vi.mocked(mineruProbe).mockReset().mockResolvedValue([]);
  vi.mocked(mineruSubmit).mockReset();
  vi.mocked(mineruMarkdown).mockReset();
  vi.mocked(saveSettings).mockReset().mockResolvedValue({ version: 2, providers: [], usage: {} });
  vi.mocked(loadSettings).mockReset().mockResolvedValue({
    version: 2,
    providers: [],
    usage: {},
  } as Awaited<ReturnType<typeof loadSettings>>);
  vi.mocked(exportDomain).mockReset();
});

afterEach(() => {
  act(() => {
    bindToastLog(null);
    dismissAll("manual");
  });
  quiet.forEach((spy) => spy.mockRestore());
  vi.useRealTimers();
  cleanup();
});

// ---------- 通知 × 日志联动（store → toasts → logger → LogPanel 全链） ----------

describe("通知 × 日志联动（错误通知自动记 error 日志、发出与关闭留痕）", () => {
  it("错误通知自动记 error 日志并即时出现在运行日志面板（warn→warn、ok→info）", () => {
    render(<LogPanel />);
    act(() => {
      useField.getState().setFlash({ tone: "error", text: "保存失败：网络错误" });
      useField.getState().setFlash({ tone: "warn", text: "请先保存笔记" });
      useField.getState().setFlash({ tone: "ok", text: "已保存。" });
    });
    const entries = getEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ level: "error", scope: "ui", message: "保存失败：网络错误" });
    expect(entries[1]).toMatchObject({ level: "warn", scope: "ui", message: "请先保存笔记" });
    expect(entries[2]).toMatchObject({ level: "info", scope: "ui", message: "已保存。" });
    // 通知堆叠三口径一致：flash 镜像、toasts 堆叠、LogPanel 行。
    expect(useField.getState().flash).toEqual({ tone: "ok", text: "已保存。" });
    expect(getToasts().map((t) => t.text)).toEqual(["保存失败：网络错误", "请先保存笔记", "已保存。"]);
    const list = screen.getByRole("log", { name: "运行日志" });
    expect(within(list).getByText(/保存失败：网络错误/)).toBeInTheDocument();
    // 「错误」过滤后只剩 error 行：错误通知在面板中按 error 级别归档。
    fireEvent.click(screen.getByRole("button", { name: "错误" }));
    expect(within(list).getByText(/保存失败：网络错误/)).toBeInTheDocument();
    expect(within(list).queryByText(/请先保存笔记/)).not.toBeInTheDocument();
    expect(within(list).queryByText(/已保存。/)).not.toBeInTheDocument();
  });

  it("通知发出与关闭都留痕：setFlash(null) 清空堆叠并逐条记「通知关闭」", () => {
    act(() => {
      useField.getState().setFlash({ tone: "error", text: "导入失败：文件损坏，数据未改动。" });
    });
    expect(getEntries()).toHaveLength(1);
    act(() => {
      useField.getState().setFlash(null);
    });
    expect(getToasts()).toHaveLength(0);
    expect(useField.getState().flash).toBeNull();
    expect(getEntries().map((e) => `${e.level}:${e.message}`)).toEqual([
      "error:导入失败：文件损坏，数据未改动。",
      "info:通知关闭（手动关闭）：导入失败：文件损坏，数据未改动。",
    ]);
  });

  it("同 (tone,text) 重复通知只 emit 一次，日志层只多一条 debug refresh", () => {
    act(() => {
      useField.getState().setFlash({ tone: "warn", text: "请先保存或取消正在编辑的笔记。" });
      useField.getState().setFlash({ tone: "warn", text: "请先保存或取消正在编辑的笔记。" });
    });
    expect(getToasts()).toHaveLength(1);
    expect(getEntries().map((e) => `${e.level}:${e.message}`)).toEqual([
      "warn:请先保存或取消正在编辑的笔记。",
      "debug:通知刷新停留计时：请先保存或取消正在编辑的笔记。",
    ]);
  });
});

// ---------- 导入 × MinerU 解析（store 与 mineruRun 联动） ----------

describe("导入 × MinerU 解析联动的通知触达", () => {
  const enabledMineru = {
    ...DEFAULT_MINERU,
    ssh: { ...DEFAULT_MINERU.ssh, enabled: true },
    configured: true,
  };

  function primeImport(options: { created?: boolean } = {}) {
    useField.setState({
      selectedDomainId: "d-1",
      mineru: enabledMineru,
      effectiveProvider: "local",
      // 可用提供商（enabled + hasKey）走「解析完成 N 篇」ok 主路径（无可用会降级为「尚未配置 AI」warn）。
      settings: {
        version: 2,
        providers: [
          {
            id: "p-llm",
            presetId: "openai",
            label: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-4o-mini",
            enabled: true,
            hasKey: true,
            requiresKey: true,
          },
        ],
        usage: {},
      },
    });
    vi.mocked(repo.getPaper).mockImplementation(async () => detailOf("p-1", { pdfPath: "/papers/a.pdf" }));
    vi.mocked(repo.importLocalPdfs).mockImplementation(async () => ({
      created: options.created === false ? [] : [{ id: "p-1" } as unknown as Paper],
      skipped: [],
    }));
  }

  it("导入成功 → 后台解析完成：导入与解析两条 ok 通知，批次起止与通知都入日志", async () => {
    primeImport();
    vi.mocked(mineruSubmit).mockResolvedValue({
      provider: "local",
      remotePath: "/remote/a.pdf",
      shortId: "doc-1",
      parseIds: [],
      status: "done",
      tier: "standard",
      credFingerprint: "pf-cred-v1:match",
    });
    vi.mocked(mineruMarkdown).mockResolvedValue("# 全文");

    await act(async () => {
      await useField.getState().importPdfs(["/papers/a.pdf"]);
    });
    await vi.waitFor(() =>
      expect(getToasts().some((t) => t.text.includes("MinerU 解析完成 1 篇"))).toBe(true),
    );

    // 通知触达：导入 ok（带生效源名）+ 解析完成 ok。
    expect(useField.getState().flash?.tone).toBe("ok");
    expect(getToasts().map((t) => t.text)).toEqual([
      expect.stringContaining("已导入 1 篇"),
      "MinerU 解析完成 1 篇。阅读状态未改动。",
    ]);
    expect(getToasts()[0]!.text).toContain("本地 CLI");
    // 日志留痕：批次起止（mineru 维度 info）+ 两条用户可见通知（ui 维度 info）。
    const messages = getEntries().map((e) => `${e.level}/${e.scope}/${e.message}`);
    expect(messages).toContain("info/mineru/解析批次开始：共 1 篇");
    expect(messages).toContain("info/mineru/解析批次结束：成功 1 篇，失败 0 篇");
    expect(messages).toContain("info/ui/MinerU 解析完成 1 篇。阅读状态未改动。");
    expect(repo.saveParsedMarkdown).toHaveBeenCalledWith("p-1", "# 全文");
  });

  it("解析失败：mineru 维度 error 与用户可见 error 通知同时留痕", async () => {
    primeImport();
    vi.mocked(mineruSubmit).mockRejectedValue(new Error("SSH 远程：curl: (28) Operation timed out"));

    await act(async () => {
      await useField.getState().importPdfs(["/papers/a.pdf"]);
    });
    await vi.waitFor(() =>
      expect(getToasts().some((t) => t.text.includes("MinerU 解析失败 1 篇"))).toBe(true),
    );

    expect(getToasts().at(-1)).toMatchObject({ tone: "error", text: "MinerU 解析失败 1 篇，可在资料栏重试。" });
    const entries = getEntries();
    const mineruError = entries.find((e) => e.level === "error" && e.scope === "mineru");
    const uiError = entries.find((e) => e.level === "error" && e.scope === "ui");
    expect(mineruError?.message).toBe("论文解析失败（p-1）");
    expect(mineruError?.detail).toContain("Operation timed out");
    expect(uiError?.message).toBe("MinerU 解析失败 1 篇，可在资料栏重试。");
    const lastState = vi.mocked(repo.setMineruState).mock.lastCall?.[1];
    expect(lastState).toMatchObject({ status: "error", error: "SSH 远程：curl: (28) Operation timed out" });
  });

  it("导入成功但无可用解析源：warn 通知指引设置页，且不提交解析", async () => {
    primeImport();
    useField.setState({ effectiveProvider: null });
    vi.mocked(mineruProbe).mockResolvedValue([]);

    await act(async () => {
      await useField.getState().importPdfs(["/papers/a.pdf"]);
    });

    expect(useField.getState().flash).toMatchObject({
      tone: "warn",
      text: expect.stringContaining("当前没有可用的 MinerU 解析源"),
    });
    expect(getEntries()).toContainEqual(
      expect.objectContaining({ level: "warn", scope: "ui", message: expect.stringContaining("未解析") }),
    );
    expect(mineruSubmit).not.toHaveBeenCalled();
  });

  it("单篇导入失败汇总为 error 通知（不中断整批语义）", async () => {
    primeImport({ created: false });
    vi.mocked(repo.importLocalPdfs).mockRejectedValue(new Error("磁盘 I/O 错误"));

    await act(async () => {
      await useField.getState().importPdfs(["/papers/a.pdf"]);
    });

    expect(useField.getState().flash).toMatchObject({
      tone: "error",
      text: "已导入 0 篇，1 篇失败：a.pdf（磁盘 I/O 错误）。",
    });
    expect(getEntries()).toContainEqual(
      expect.objectContaining({ level: "error", scope: "ui", message: "已导入 0 篇，1 篇失败：a.pdf（磁盘 I/O 错误）。" }),
    );
  });

  it("导入后刷新库失败走整批 error（导入失败：…，数据未改动）并向上抛出", async () => {
    primeImport();
    vi.mocked(repo.listDomains).mockRejectedValue(new Error("数据库被锁定"));

    await expect(
      act(async () => {
        await useField.getState().importPdfs(["/papers/a.pdf"]);
      }),
    ).rejects.toThrow("数据库被锁定");

    expect(useField.getState().flash).toMatchObject({ tone: "error", text: "导入失败：数据库被锁定，数据未改动。" });
    expect(getEntries()).toContainEqual(
      expect.objectContaining({ level: "error", scope: "ui", message: "导入失败：数据库被锁定，数据未改动。" }),
    );
  });
});

// ---------- MinerU 解析后的自动补全（saveLlmSettings → backfillMeta → runJob 深链） ----------

describe("设置保存 × MinerU 补全深链路", () => {
  it("保存 AI 设置（带可用提供商）→ 后台补全 1 篇 → ok 通知与 llm 作业日志；quiet 补全不刷「AI 作业完成」", async () => {
    vi.mocked(saveSettings).mockResolvedValue({ version: 2, providers: [], usage: {} });
    vi.mocked(loadSettings).mockResolvedValue({
      version: 2,
      providers: [
        {
          id: "p-llm",
          presetId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          enabled: true,
          hasKey: true,
          requiresKey: true,
        },
      ],
      usage: {},
    } as Awaited<ReturnType<typeof loadSettings>>);
    vi.mocked(repo.listReadyForMeta).mockResolvedValue(["p-9"]);
    vi.mocked(repo.createJob).mockResolvedValue({
      id: "job-bf",
      paperId: "p-9",
      type: "prepareMeta",
      status: "queued",
      prompt: "p",
      resultJson: null,
      error: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    } as LlmJob);
    // getPaper 三跳：autoPrepare 检查 → runPrepareMeta 取详情 → autoPrepare 复核（已补全）。
    let reads = 0;
    vi.mocked(repo.getPaper).mockImplementation(async () => {
      reads += 1;
      return detailOf("p-9", {
        pdfPath: "/papers/9.pdf",
        parsedMarkdown: "# 已解析全文",
        llmPreparedAt: reads >= 3 ? "2024-01-02T00:00:00.000Z" : null,
      });
    });

    await act(async () => {
      await useField.getState().saveLlmSettings({
        providers: [
          {
            id: "p-llm",
            presetId: "openai",
            label: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-4o-mini",
            enabled: true,
            requiresKey: true,
            apiKey: "sk-x",
          },
        ],
      });
    });
    await vi.waitFor(() =>
      expect(getToasts().some((t) => t.text.includes("已为 1 篇论文补全信息"))).toBe(true),
    );

    expect(getToasts().map((t) => t.text)).toEqual(["AI 服务设置已保存。", "已为 1 篇论文补全信息。阅读状态未改动。"]);
    const messages = getEntries().map((e) => `${e.level}/${e.scope}/${e.message}`);
    expect(messages).toContain("info/ui/AI 服务设置已保存。");
    expect(messages).toContain("info/llm/AI 作业开始（job-bf）");
    expect(messages).toContain("info/llm/AI 作业完成（job-bf）");
    // 自动补全 overwrite=false（用户编辑锁）+ quiet（不刷「AI 作业完成。」通知）。
    // 第四参带上开始时的 meta_rev 与作业 id，写入时再对一次，飞行中的手改不会被盖掉。
    expect(repo.applyPreparedMeta).toHaveBeenCalledWith(
      "p-9",
      expect.anything(),
      false,
      expect.objectContaining({ source: "llm", jobId: "job-bf" }),
    );
    expect(getToasts().some((t) => t.text === "AI 作业完成。阅读状态未改动。")).toBe(false);
  });

  it("保存 AI 设置失败：error 通知留痕并向上抛出（数据未改动）", async () => {
    vi.mocked(saveSettings).mockRejectedValue(new Error("磁盘只读"));

    await expect(
      act(async () => {
        await useField.getState().saveLlmSettings({ providers: [] });
      }),
    ).rejects.toThrow("磁盘只读");

    expect(useField.getState().flash).toMatchObject({ tone: "error", text: "保存 AI 服务设置失败：磁盘只读，数据未改动。" });
    expect(getEntries()).toContainEqual(
      expect.objectContaining({ level: "error", scope: "ui", message: "保存 AI 服务设置失败：磁盘只读，数据未改动。" }),
    );
  });

  it("保存提供商但无任何可用（缺 Key）：降级为 warn 通知", async () => {
    vi.mocked(saveSettings).mockResolvedValue({ version: 2, providers: [], usage: {} });
    vi.mocked(loadSettings).mockResolvedValue({
      version: 2,
      providers: [
        {
          id: "p-llm",
          presetId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          enabled: true,
          hasKey: false,
          requiresKey: true,
        },
      ],
      usage: {},
    } as Awaited<ReturnType<typeof loadSettings>>);

    await act(async () => {
      await useField.getState().saveLlmSettings({
        providers: [
          {
            id: "p-llm",
            presetId: "openai",
            label: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-4o-mini",
            enabled: true,
            requiresKey: true,
            apiKey: null,
          },
        ],
      });
    });

    expect(useField.getState().flash).toMatchObject({
      tone: "warn",
      text: "已保存提供商列表，但当前没有可用的 AI 服务：请启用并填写 API Key，或使用免 Key 的本地服务。",
    });
    expect(getEntries()).toContainEqual(
      expect.objectContaining({
        level: "warn",
        scope: "ui",
        message: "已保存提供商列表，但当前没有可用的 AI 服务：请启用并填写 API Key，或使用免 Key 的本地服务。",
      }),
    );
  });

  it("保存 MinerU 设置成功：ok 通知指引重探", async () => {
    vi.mocked(saveMineru).mockResolvedValue({ ...DEFAULT_MINERU, configured: true });

    await act(async () => {
      await useField.getState().saveMineruSettings({
        order: ["local", "ssh", "api"],
        local: { enabled: true, socketPath: "~/.mineru/doclib.sock" },
        ssh: {
          enabled: false,
          host: "",
          port: 22,
          user: "",
          identityFile: "",
          socketPath: "~/.mineru/doclib.sock",
          inboxDir: "~/.mineru/paper-field-inbox",
        },
        api: {
          token: null,
          modelVersion: "pipeline",
          language: "ch",
          enableFormula: true,
          enableTable: true,
        },
        tier: "standard",
        pageRange: "all",
      });
    });

    expect(useField.getState().flash).toMatchObject({
      tone: "ok",
      text: "MinerU 设置已保存，正在重新探测各解析源。",
    });
    expect(getEntries()).toContainEqual(
      expect.objectContaining({ level: "info", scope: "ui", message: "MinerU 设置已保存，正在重新探测各解析源。" }),
    );
  });
});

// ---------- 导出 ----------

describe("导出的通知触达", () => {
  beforeEach(() => {
    useField.setState({ selectedDomainId: "d-1" });
    vi.mocked(repo.getDomain).mockImplementation(async () => domainOf("d-1"));
    vi.mocked(repo.papersForExport).mockResolvedValue([detailOf("a"), detailOf("b")]);
  });

  it("导出成功：ok 通知带篇数与去向并留 info 日志", async () => {
    vi.mocked(exportDomain).mockResolvedValue("/tmp/export");

    await act(async () => {
      await useField.getState().exportCurrentDomain();
    });

    expect(useField.getState().flash).toMatchObject({ tone: "ok", text: "已导出 2 篇 · /tmp/export" });
    expect(getEntries()).toContainEqual(
      expect.objectContaining({ level: "info", scope: "ui", message: "已导出 2 篇 · /tmp/export" }),
    );
  });

  it("用户取消目录选择（EXPORT_CANCELLED）：无通知、无 emit 日志", async () => {
    vi.mocked(exportDomain).mockRejectedValue(new Error("EXPORT_CANCELLED"));

    await act(async () => {
      await useField.getState().exportCurrentDomain();
    });

    expect(useField.getState().flash).toBeNull();
    expect(getToasts()).toHaveLength(0);
    expect(getEntries()).toHaveLength(0);
  });

  it("导出失败：error 通知留痕（不向上抛）", async () => {
    vi.mocked(exportDomain).mockRejectedValue(new Error("写入目标目录失败"));

    await act(async () => {
      await useField.getState().exportCurrentDomain();
    });

    expect(useField.getState().flash).toMatchObject({ tone: "error", text: "写入目标目录失败" });
    expect(getEntries()).toContainEqual(
      expect.objectContaining({ level: "error", scope: "ui", message: "写入目标目录失败" }),
    );
  });
});

// ---------- 领域管理 ----------

describe("领域管理的通知触达", () => {
  it("删除领域失败：error 通知留痕并向上抛出（数据未改动）", async () => {
    useField.setState({ selectedDomainId: "d-1" });
    vi.mocked(repo.deleteDomain).mockRejectedValue(new Error("领域下仍有 12 篇论文"));

    await expect(
      act(async () => {
        await useField.getState().deleteDomain();
      }),
    ).rejects.toThrow("领域下仍有 12 篇论文");

    expect(useField.getState().flash).toMatchObject({
      tone: "error",
      text: "删除领域失败：领域下仍有 12 篇论文，数据未改动。",
    });
    expect(getEntries()).toContainEqual(
      expect.objectContaining({ level: "error", scope: "ui", message: "删除领域失败：领域下仍有 12 篇论文，数据未改动。" }),
    );
  });

  it("现状基线：创建 / 删除领域成功不产生任何通知（缺口已记录，防进一步劣化）", async () => {
    useField.setState({ selectedDomainId: "d-1" });
    vi.mocked(repo.deleteDomain).mockResolvedValue(undefined);
    vi.mocked(repo.listDomains).mockResolvedValue([]);
    vi.mocked(repo.createDomain).mockResolvedValue(domainOf("d-2"));

    await act(async () => {
      await useField.getState().deleteDomain();
    });
    await act(async () => {
      await useField.getState().createDomain({ name: "新领域", code: "" });
    });

    expect(useField.getState().selectedDomainId).toBe("d-2");
    expect(getToasts()).toHaveLength(0);
    expect(getEntries()).toHaveLength(0);
  });
});

// ---------- 持久化异常（logger 落盘 / 存储初始化） ----------

describe("持久化异常 × 通知层互不破坏（Tauri 分支）", () => {
  it("错误通知经日志链路 3s 防抖后随 app-log.json 落盘（只含 ≥info）", async () => {
    vi.useFakeTimers();
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(storeLoad).mockClear();
    fakeStore.set.mockClear();
    fakeStore.save.mockClear();
    fakeStore.set.mockResolvedValue(undefined);
    fakeStore.save.mockResolvedValue(undefined);

    act(() => {
      useField.getState().setFlash({ tone: "error", text: "保存失败：网络错误" });
      useField.getState().setFlash({ tone: "ok", text: "已保存。" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });
    expect(fakeStore.set).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(fakeStore.set).toHaveBeenCalledTimes(1);
    const [key, value] = fakeStore.set.mock.calls[0]!;
    expect(key).toBe("entries");
    const persisted = value as Array<{ level: string; scope: string; message: string }>;
    expect(persisted.map((e) => e.message)).toEqual(["保存失败：网络错误", "已保存。"]);
    expect(persisted[0]).toMatchObject({ level: "error", scope: "ui" });
  });

  it("落盘失败降级：只记一条 warn，此后新通知照常入堆叠与内存日志，且不再重试落盘", async () => {
    vi.useFakeTimers();
    vi.mocked(isTauri).mockReturnValue(true);
    fakeStore.set.mockClear();
    fakeStore.save.mockClear();
    fakeStore.set.mockResolvedValue(undefined);
    fakeStore.save.mockRejectedValue(new Error("disk full"));

    act(() => {
      useField.getState().setFlash({ tone: "error", text: "第一条错误" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });

    // 降级只写一条 warn（logger 自身不走通知层，用户不可见，缓冲可查）。
    expect(
      getEntries().some((e) => e.level === "warn" && e.message.includes("运行日志落盘失败")),
    ).toBe(true);
    expect(fakeStore.set).toHaveBeenCalledTimes(1);

    act(() => {
      useField.getState().setFlash({ tone: "error", text: "降级后的新错误" });
    });
    // 推进 4s（< error 通知 8s 停留，避免把「降级后的新错误」自动消掉）：
    // 若降级失效，这里会再排一次 flush 并调用 fakeStore.set。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(getToasts().map((t) => t.text)).toEqual(["第一条错误", "降级后的新错误"]);
    expect(getEntries()).toContainEqual(
      expect.objectContaining({ level: "error", scope: "ui", message: "降级后的新错误" }),
    );
    expect(fakeStore.set).toHaveBeenCalledTimes(1); // 降级后不再重试
  });

  it("存储初始化失败：整页错误路径不走 toast，但必须留 error 日志", async () => {
    vi.mocked(repo.init).mockRejectedValue(new Error("db locked"));

    await act(async () => {
      await useField.getState().init();
    });

    expect(useField.getState().error).toBe("db locked");
    expect(useField.getState().ready).toBe(true);
    expect(getToasts()).toHaveLength(0);
    expect(getEntries()).toContainEqual(
      expect.objectContaining({ level: "error", scope: "store", message: "存储初始化失败", detail: "db locked" }),
    );
  });

  it("App 挂载时把 engine 的 SQLite 落盘失败接到 notify(error) 收口（源码口径，先例：Toasts.test 的 CSS 断言）", () => {
    // 行为侧（notify(error) → error 日志）已由本文件首组用例覆盖；此处固定产品接线不回退。
    expect(appSource).toContain('setPersistFailureHandler((message) => notify("error", message))');
  });
});

// ---------- 回归：两项改动未破坏的既有行为 ----------

describe("既有行为回归基线", () => {
  it("未保存笔记拦截模式切换：warn 通知 + warn 日志，mode 不变", async () => {
    useField.setState({ mode: "field", unsavedNote: true });

    await act(async () => {
      await useField.getState().setMode("archive");
    });

    expect(useField.getState().mode).toBe("field");
    expect(useField.getState().flash).toMatchObject({ tone: "warn", text: "请先保存或取消正在编辑的笔记。" });
    expect(getEntries()).toContainEqual(
      expect.objectContaining({ level: "warn", scope: "ui", message: "请先保存或取消正在编辑的笔记。" }),
    );
  });

  it("LogPanel 的「复制」提示也走通知链：留 ok 日志且面板无需重挂载即可见", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<LogPanel />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制" }));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(getToasts().map((t) => t.text)).toEqual(["运行日志已复制到剪贴板。"]);
    expect(getEntries().at(-1)).toMatchObject({ level: "info", scope: "ui", message: "运行日志已复制到剪贴板。" });
    // 通知产生的新日志即时反映在已挂载面板（useSyncExternalStore 订阅链未断）。
    expect(await screen.findByText(/运行日志已复制到剪贴板。/)).toBeInTheDocument();
  });

  it("错误通知自动消退（8s）也留「自动消退」关闭痕迹", async () => {
    vi.useFakeTimers();
    render(<LogPanel />);
    act(() => {
      useField.getState().setFlash({ tone: "error", text: "自动消退的错误" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });

    expect(getToasts()).toHaveLength(0);
    expect(getEntries().map((e) => `${e.level}:${e.message}`)).toEqual([
      "error:自动消退的错误",
      "info:通知关闭（自动消退）：自动消退的错误",
    ]);
  });
});
