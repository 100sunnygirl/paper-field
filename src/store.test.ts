import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperDetail, PaperListItem } from "./lib/types";
import { useField } from "./store";

vi.mock("./lib/repo", () => ({
  repo: {
    init: vi.fn(async () => undefined),
    getPaper: vi.fn(async () => null),
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    listFailedMineru: vi.fn(async () => [] as string[]),
    createDomain: vi.fn(),
    setReadingStatus: vi.fn(async () => undefined),
    setMineruState: vi.fn(async () => undefined),
    resetMineru: vi.fn(async () => undefined),
    activeJobIds: vi.fn(async () => []),
    deletePapers: vi.fn(async () => undefined),
  },
}));

import { DEFAULT_MINERU } from "./lib/mineru";
import { clear as clearLog, getEntries, log } from "./lib/logger";
import { repo } from "./lib/repo";
import { bindToastLog, dismissAll } from "./toasts";

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

function detailOf(id: string): PaperDetail {
  return { ...listItem(id), authors: [], notes: {} as PaperDetail["notes"], domain: {} as PaperDetail["domain"], parsedMarkdown: "" };
}

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
  vi.mocked(repo.getPaper).mockReset();
  vi.mocked(repo.listArchive).mockClear();
  vi.mocked(repo.listIntake).mockClear();
  vi.mocked(repo.listPapers).mockClear();
  vi.mocked(repo.listFailedMineru).mockReset();
  vi.mocked(repo.setReadingStatus).mockReset();
  vi.mocked(repo.setMineruState).mockReset();
  vi.mocked(repo.createDomain).mockReset();
  vi.mocked(repo.deletePapers).mockReset();
});

describe("setReadingStatus 轻量撤销（含已读时间戳恢复）", () => {
  function statusDetail(id: string, readingStatus: PaperDetail["readingStatus"], readAt: string | null): PaperDetail {
    return { ...detailOf(id), readingStatus, readAt };
  }

  it("状态变化后提示带「撤销」：点击恢复上一个状态并写回归档的已读时间戳", async () => {
    const historic = "2020-01-01T00:00:00.000Z";
    vi.mocked(repo.getPaper).mockImplementation(async () => statusDetail("p-1", "read", historic));
    useField.setState({ mode: "field" });
    await useField.getState().setReadingStatus("unread", "p-1");
    expect(repo.setReadingStatus).toHaveBeenCalledWith("p-1", "unread");
    const flash = useField.getState().flash;
    expect(flash?.text).toBe("阅读状态已更新为未读。");
    expect(flash?.action?.label).toBe("撤销");
    flash!.action!.run();
    await vi.waitFor(() =>
      expect(repo.setReadingStatus).toHaveBeenCalledWith("p-1", "read", historic),
    );
  });

  it("撤销回「在读」时把 read_at 恢复为归档的 null，不沿用已读时间", async () => {
    // 场景：在读（read_at 为 null）被误改成未读，撤销应原样回到「在读 + null」。
    vi.mocked(repo.getPaper).mockImplementation(async () => statusDetail("p-1", "reading", null));
    useField.setState({ mode: "field" });
    await useField.getState().setReadingStatus("unread", "p-1");
    useField.getState().flash!.action!.run();
    await vi.waitFor(() => expect(repo.setReadingStatus).toHaveBeenCalledWith("p-1", "reading", null));
  });

  it("状态没变（重选同一项）或读不到当前论文时不提供撤销", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async () => statusDetail("p-1", "reading", null));
    useField.setState({ mode: "field" });
    await useField.getState().setReadingStatus("reading", "p-1");
    expect(useField.getState().flash?.text).toBe("阅读状态已更新为在读。");
    expect(useField.getState().flash?.action).toBeUndefined();

    vi.mocked(repo.getPaper).mockImplementation(async () => null);
    await useField.getState().setReadingStatus("read", "p-missing");
    expect(useField.getState().flash?.action).toBeUndefined();
  });

  it("改为在读时本机记下「在读起点」（在读第 N 天的数据源）", async () => {
    localStorage.removeItem("paper-field.reading-since");
    vi.mocked(repo.getPaper).mockImplementation(async () => statusDetail("p-1", "unread", null));
    useField.setState({ mode: "field" });
    await useField.getState().setReadingStatus("reading", "p-1");
    const records = JSON.parse(localStorage.getItem("paper-field.reading-since") ?? "{}") as Record<string, string>;
    expect(records["p-1"]).toBeTypeOf("string");
    // 再改已读：起点保留；改未读：清除
    vi.mocked(repo.getPaper).mockImplementation(async () => statusDetail("p-1", "reading", null));
    await useField.getState().setReadingStatus("read", "p-1");
    expect(JSON.parse(localStorage.getItem("paper-field.reading-since")!)["p-1"]).toBe(records["p-1"]);
    vi.mocked(repo.getPaper).mockImplementation(async () => statusDetail("p-1", "read", records["p-1"]));
    await useField.getState().setReadingStatus("unread", "p-1");
    expect(JSON.parse(localStorage.getItem("paper-field.reading-since") ?? "{}")["p-1"]).toBeUndefined();
    localStorage.removeItem("paper-field.reading-since");
  });

  it("真正转入已读时 readPulse +1；重复标已读不再脉冲", async () => {
    useField.setState({ mode: "field", readPulse: 0 });
    vi.mocked(repo.getPaper).mockImplementation(async () => statusDetail("p-1", "reading", null));
    await useField.getState().setReadingStatus("read", "p-1");
    expect(useField.getState().readPulse).toBe(1);
    // 已读再选一次已读：没有状态变化，不脉冲
    vi.mocked(repo.getPaper).mockImplementation(async () => statusDetail("p-1", "read", "2026-01-01T00:00:00.000Z"));
    await useField.getState().setReadingStatus("read", "p-1");
    expect(useField.getState().readPulse).toBe(1);
    // 已读改在读再标回已读：又一次真正的转入，再脉冲
    vi.mocked(repo.getPaper).mockImplementation(async () => statusDetail("p-1", "reading", "2026-01-01T00:00:00.000Z"));
    await useField.getState().setReadingStatus("read", "p-1");
    expect(useField.getState().readPulse).toBe(2);
  });
});

describe("navigatePapers（缺陷 9：未选中时的首末落点）", () => {
  it("未选中时 ↓ 选中第 1 篇", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => detailOf(id as string));
    useField.setState({ mode: "field", papers: [listItem("a"), listItem("b"), listItem("c")], selectedPaperId: null });
    await useField.getState().navigatePapers(1);
    expect(useField.getState().selectedPaperId).toBe("a");
    expect(repo.getPaper).toHaveBeenCalledWith("a");
  });

  it("未选中时 ↑ 选中末篇", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => detailOf(id as string));
    useField.setState({ mode: "field", papers: [listItem("a"), listItem("b"), listItem("c")], selectedPaperId: null });
    await useField.getState().navigatePapers(-1);
    expect(useField.getState().selectedPaperId).toBe("c");
  });

  it("已选中第 1 篇时 ↑ 保持第 1 篇（clamp）", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => detailOf(id as string));
    useField.setState({ mode: "field", papers: [listItem("a"), listItem("b"), listItem("c")], selectedPaperId: "a" });
    await useField.getState().navigatePapers(-1);
    expect(useField.getState().selectedPaperId).toBe("a");
  });

  it("中间篇 ↓ / ↑ 正常移动", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => detailOf(id as string));
    useField.setState({ mode: "field", papers: [listItem("a"), listItem("b"), listItem("c")], selectedPaperId: "b" });
    await useField.getState().navigatePapers(1);
    expect(useField.getState().selectedPaperId).toBe("c");
    await useField.getState().navigatePapers(-1);
    expect(useField.getState().selectedPaperId).toBe("b");
  });

  it("归档模式沿归档列表导航（而非当前领域列表）", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => detailOf(id as string));
    useField.setState({
      mode: "archive",
      papers: [listItem("field-only")],
      archive: [listItem("x"), listItem("y")],
      selectedPaperId: null,
    });
    await useField.getState().navigatePapers(1);
    expect(useField.getState().selectedPaperId).toBe("x");
  });

  it("有笔记草稿时导航不再被拦：草稿按论文保留，切回来还在", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => detailOf(id as string));
    useField.setState({
      mode: "field",
      papers: [listItem("a"), listItem("b")],
      selectedPaperId: "a",
    });
    useField.getState().setNoteDraft("a", "summary", "写了一半");
    await useField.getState().navigatePapers(1);
    expect(useField.getState().selectedPaperId).toBe("b");
    expect(useField.getState().drafts.a?.summary).toBe("写了一半");
    useField.getState().setNoteDraft("a", "summary", null);
  });

  it("设置页里方向键不切换论文", async () => {
    useField.setState({ mode: "system", papers: [listItem("a"), listItem("b")], selectedPaperId: "a" });
    await useField.getState().navigatePapers(1);
    expect(useField.getState().selectedPaperId).toBe("a");
  });

  it("空列表时不动作", async () => {
    useField.setState({ mode: "field", papers: [] });
    await useField.getState().navigatePapers(1);
    expect(useField.getState().selectedPaperId).toBeNull();
  });
});

describe("refresh 在三种模式下的搜索接线", () => {
  it("archive 模式：listArchive 带搜索词、listIntake 不带", async () => {
    useField.setState({ mode: "archive", search: "关键词", archiveFilter: "all" });
    await useField.getState().refresh();
    expect(repo.listArchive).toHaveBeenCalledWith({ search: "关键词", openSource: "all" });
    expect(repo.listIntake).toHaveBeenCalledWith("");
    expect(repo.listPapers).not.toHaveBeenCalledWith(expect.anything(), "关键词");
  });

  it("intake 模式：listIntake 带搜索词、listArchive 不带", async () => {
    useField.setState({ mode: "intake", search: "关键词", archiveFilter: "all" });
    await useField.getState().refresh();
    expect(repo.listIntake).toHaveBeenCalledWith("关键词");
    expect(repo.listArchive).toHaveBeenCalledWith({ search: "", openSource: "all" });
  });

  it("field 模式：listPapers 带搜索词，两列表不带", async () => {
    useField.setState({ mode: "field", search: "关键词", selectedDomainId: "d-1" });
    await useField.getState().refresh();
    expect(repo.listPapers).toHaveBeenCalledWith("d-1", "关键词");
    expect(repo.listArchive).toHaveBeenCalledWith({ search: "", openSource: "all" });
    expect(repo.listIntake).toHaveBeenCalledWith("");
  });

  it("选中论文已被删除时回落到首篇", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => (id === "gone" ? null : detailOf(id as string)));
    vi.mocked(repo.listPapers).mockResolvedValue([listItem("a"), listItem("b")]);
    useField.setState({ mode: "field", selectedDomainId: "d-1", selectedPaperId: "gone" });
    await useField.getState().refresh();
    expect(useField.getState().selectedPaperId).toBe("a");
  });

  it("选中论文只是不在搜索结果里：保持选中，不自动跳到别的论文", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => detailOf(id as string));
    vi.mocked(repo.listPapers).mockResolvedValue([listItem("a"), listItem("b")]);
    useField.setState({ mode: "field", selectedDomainId: "d-1", selectedPaperId: "c" });
    await useField.getState().refresh();
    expect(useField.getState().selectedPaperId).toBe("c");
    expect(useField.getState().paper?.id).toBe("c");
  });

  it("切换模式（用户导航）时选中不在新列表里才改选首篇", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => detailOf(id as string));
    vi.mocked(repo.listArchive).mockResolvedValue([listItem("r1")]);
    useField.setState({ mode: "field", selectedDomainId: "d-1", selectedPaperId: "c" });
    await useField.getState().setMode("archive");
    expect(useField.getState().selectedPaperId).toBe("r1");
  });

  it("刷新期间用户改选：刷新结束不把选中改回去", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => detailOf(id as string));
    vi.mocked(repo.listPapers).mockImplementation(async () => {
      await gate;
      return [listItem("a"), listItem("b")];
    });
    useField.setState({ mode: "field", selectedDomainId: "d-1", selectedPaperId: "a" });
    const refreshing = useField.getState().refresh();
    await useField.getState().selectPaper("b");
    release();
    await refreshing;
    expect(useField.getState().selectedPaperId).toBe("b");
    expect(useField.getState().paper?.id).toBe("b");
  });
});

describe("retryFailedMineru（INTAKE 批量重试）", () => {
  const configuredMineru = {
    ...DEFAULT_MINERU,
    ssh: { ...DEFAULT_MINERU.ssh, enabled: true },
    configured: true,
  };

  it("把全部解析失败论文重置为 queued 并重新排队", async () => {
    vi.mocked(repo.listFailedMineru).mockResolvedValue(["e1", "e2"]);
    useField.setState({ mineru: configuredMineru });

    await useField.getState().retryFailedMineru();

    // 一次事务重置全部（并收回解析所有权，旧的一轮写入不再生效）
    expect(repo.resetMineru).toHaveBeenCalledTimes(1);
    expect(repo.resetMineru).toHaveBeenCalledWith(["e1", "e2"]);
    const flash = useField.getState().flash;
    expect(flash?.tone).toBe("ok");
    expect(flash?.text).toContain("已将 2 篇重新发送到 MinerU 解析");
  });

  it("没有失败论文时提示且不动数据", async () => {
    vi.mocked(repo.listFailedMineru).mockResolvedValue([]);
    useField.setState({ mineru: configuredMineru });

    await useField.getState().retryFailedMineru();

    expect(repo.setMineruState).not.toHaveBeenCalled();
    expect(useField.getState().flash?.text).toBe("没有解析失败的论文。");
  });

  it("未配置解析源时给出设置页指引", async () => {
    vi.mocked(repo.listFailedMineru).mockResolvedValue(["e1"]);
    useField.setState({ mineru: DEFAULT_MINERU });

    await useField.getState().retryFailedMineru();

    expect(repo.setMineruState).not.toHaveBeenCalled();
    expect(useField.getState().flash?.text).toContain("尚未启用任何 MinerU 解析源");
  });
});

describe("作业面板批量与分型重试", () => {
  const configuredMineru = {
    ...DEFAULT_MINERU,
    ssh: { ...DEFAULT_MINERU.ssh, enabled: true },
    configured: true,
  };
  const usableSettings = {
    version: 2 as const,
    usage: {},
    providers: [
      {
        id: "a",
        presetId: "deepseek",
        label: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        enabled: true,
        hasKey: true,
        requiresKey: true,
      },
    ],
  };

  it("retryMineruPapers：去重后一次事务重置并整批重新排队", async () => {
    useField.setState({ mineru: configuredMineru });

    await useField.getState().retryMineruPapers(["e1", "e2", "e2"]);

    expect(repo.resetMineru).toHaveBeenCalledWith(["e1", "e2"]);
    expect(useField.getState().flash?.tone).toBe("ok");
    expect(useField.getState().flash?.text).toContain("已将 2 篇重新发送到 MinerU 解析");
  });

  it("retryHistoryJob：补全重试不覆盖手改，起草笔记先打开确认", async () => {
    const draft = vi.fn(async () => undefined);
    const prepare = vi.fn(async () => undefined);
    useField.setState({ runDraftNotes: draft, runPrepareMeta: prepare });

    await useField.getState().retryHistoryJob("p1", "draftNotes");
    await useField.getState().retryHistoryJob("p2", "prepareMeta");
    await useField.getState().retryHistoryJob("p3", "mineruParse");

    expect(draft).toHaveBeenCalledWith("p1");
    expect(prepare).toHaveBeenCalledWith("p2", false, false);
  });

  it("retryFailedMetaJobs：无可用 AI 时给设置页指引，不排队", async () => {
    await useField.getState().retryFailedMetaJobs(["p1"]);

    expect(useField.getState().flash?.tone).toBe("warn");
    expect(useField.getState().flash?.text).toContain("尚未配置可用的 AI 服务");
  });

  it("retryFailedMetaJobs：有可用提供商时排队静默重跑并提示", async () => {
    useField.setState({ settings: usableSettings });

    await useField.getState().retryFailedMetaJobs(["p1", "p2"]);

    expect(useField.getState().flash?.tone).toBe("ok");
    expect(useField.getState().flash?.text).toBe("已重新提交 2 篇补全（进度见作业面板）。");
  });
});

describe("批量选择与批量删除（batchMode / deleteCheckedPapers）", () => {
  it("deleteCheckedPapers：按勾选批量删除、退出批量模式、清空勾选并提示", async () => {
    vi.mocked(repo.listPapers).mockResolvedValue([]);
    useField.setState({
      mode: "field",
      selectedDomainId: "d-1",
      batchMode: true,
      checkedPaperIds: ["a", "b"],
      papers: [listItem("a"), listItem("b")],
      selectedPaperId: "a",
    });
    useField.getState().setNoteDraft("a", "summary", "草稿");

    await useField.getState().deleteCheckedPapers();

    expect(repo.deletePapers).toHaveBeenCalledWith(["a", "b"]);
    const state = useField.getState();
    expect(state.batchMode).toBe(false);
    expect(state.checkedPaperIds).toEqual([]);
    expect(state.selectedPaperId).toBeNull();
    // 被删论文的草稿一并清掉
    expect(state.drafts.a).toBeUndefined();
    expect(state.flash).toMatchObject({ tone: "ok" });
    expect(state.flash?.text).toContain("已删除 2 篇论文");
  });

  it("deleteCheckedPapers 失败时提示且状态原样（不退出批量模式）", async () => {
    vi.mocked(repo.deletePapers).mockRejectedValue(new Error("db locked"));
    useField.setState({ batchMode: true, checkedPaperIds: ["a"], papers: [listItem("a")] });

    await expect(useField.getState().deleteCheckedPapers()).rejects.toThrow("db locked");
    const state = useField.getState();
    expect(state.flash).toMatchObject({ tone: "error" });
    expect(state.flash?.text).toContain("数据未改动");
    expect(state.batchMode).toBe(true);
    expect(state.checkedPaperIds).toEqual(["a"]);
  });

  it("未勾选时 deleteCheckedPapers 直接返回，不触发删除", async () => {
    await useField.getState().deleteCheckedPapers();
    expect(repo.deletePapers).not.toHaveBeenCalled();
  });

  it("toggleCheckedPaper 在勾选/取消间切换；退出批量模式清空勾选", () => {
    useField.setState({ batchMode: true, checkedPaperIds: [] });
    useField.getState().toggleCheckedPaper("a");
    expect(useField.getState().checkedPaperIds).toEqual(["a"]);
    useField.getState().toggleCheckedPaper("b");
    expect(useField.getState().checkedPaperIds).toEqual(["a", "b"]);
    useField.getState().toggleCheckedPaper("a");
    expect(useField.getState().checkedPaperIds).toEqual(["b"]);

    useField.getState().setBatchMode(false);
    expect(useField.getState().batchMode).toBe(false);
    expect(useField.getState().checkedPaperIds).toEqual([]);
  });

  it("refresh 把勾选向当前列表裁剪（搜索/切换后旧勾选不残留）", async () => {
    vi.mocked(repo.listPapers).mockResolvedValue([listItem("a")]);
    useField.setState({ mode: "field", selectedDomainId: "d-1", checkedPaperIds: ["a", "ghost"] });
    await useField.getState().refresh();
    expect(useField.getState().checkedPaperIds).toEqual(["a"]);
  });
});

describe("createDomain / updateDomain（仅名称必填）", () => {
  it("缺少名称时报「领域名称必填」，不再要求短码", async () => {
    await expect(useField.getState().createDomain({ name: "  ", code: "MM-1" })).rejects.toThrow(
      "领域名称必填",
    );
  });

  it("短码留空也能创建", async () => {
    vi.mocked(repo.createDomain).mockResolvedValue({
      id: "d-new",
      name: "多模态",
      code: "D-01",
      summary: null,
      sortOrder: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    await useField.getState().createDomain({ name: "多模态", code: "" });
    expect(repo.createDomain).toHaveBeenCalledWith({ name: "多模态", code: "" });
  });
});

describe("setFlash × notify：通知唯一收口", () => {
  beforeEach(async () => {
    // toasts 堆叠是模块级单例：先摘 sink 清空堆叠（前序用例的残留通知），
    // 再清日志缓冲，保证本组断言只看到自己的事件。
    bindToastLog(null);
    dismissAll("manual");
    await clearLog();
    // 与 main.tsx 同规则的 sink（产品侧唯一注入点在 main.tsx，测试环境不经 main）：
    // emit 按 tone 映射级别（ok→info / warn→warn / error→error），dismiss / evict
    // 记 info，refresh 高频只记 debug。
    bindToastLog((event) => {
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
  });

  afterEach(() => {
    bindToastLog(null);
  });

  it("error / warn / ok 通知经 notify 收口入运行日志（scope=ui，ok 为 info 级）；null 清空堆叠并记关闭", () => {
    useField.getState().setFlash({ tone: "error", text: "保存失败：网络错误" });
    useField.getState().setFlash({ tone: "warn", text: "请先保存笔记" });
    useField.getState().setFlash({ tone: "ok", text: "已保存。" });
    useField.getState().setFlash(null);
    const entries = getEntries();
    expect(entries).toHaveLength(6);
    expect(entries[0]).toMatchObject({ level: "error", scope: "ui", message: "保存失败：网络错误" });
    expect(entries[1]).toMatchObject({ level: "warn", scope: "ui", message: "请先保存笔记" });
    expect(entries[2]).toMatchObject({ level: "info", scope: "ui", message: "已保存。" });
    // setFlash(null) 桥接为清空堆叠：在场 3 条各记一条手动关闭日志。
    expect(entries.slice(3).map((e) => e.message)).toEqual([
      "通知关闭（手动关闭）：保存失败：网络错误",
      "通知关闭（手动关闭）：请先保存笔记",
      "通知关闭（手动关闭）：已保存。",
    ]);
  });

  it("flash 字段照常写入（兼容直接读取 state.flash 的既有用法）", () => {
    useField.getState().setFlash({ tone: "warn", text: "W" });
    expect(useField.getState().flash).toEqual({ tone: "warn", text: "W" });
    useField.getState().setFlash(null);
    expect(useField.getState().flash).toBeNull();
  });

  it("非 Tauri 下收口链路零 IPC（日志落盘也走 invoke，绕过校验防回归）", async () => {
    vi.useFakeTimers();
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      vi.mocked(invoke).mockClear();
      useField.getState().setFlash({ tone: "error", text: "boom" });
      useField.getState().setFlash({ tone: "warn", text: "careful" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getEntries().length).toBeGreaterThanOrEqual(2);
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("搜索残留可见化（searchCarried）", () => {
  it("带着搜索词切换领域记 searchCarried；再输入或清空即解除", async () => {
    useField.setState({ mode: "field", selectedDomainId: "d-1", search: "旧词", searchCarried: false });
    await useField.getState().selectDomain("d-2");
    expect(useField.getState().searchCarried).toBe(true);

    await useField.getState().setSearch("新词");
    expect(useField.getState().search).toBe("新词");
    expect(useField.getState().searchCarried).toBe(false);
  });

  it("没有搜索词时切换领域不记残留；同一领域重复选择也不记", async () => {
    useField.setState({ mode: "field", selectedDomainId: "d-1", search: "" });
    await useField.getState().selectDomain("d-2");
    expect(useField.getState().searchCarried).toBe(false);

    useField.setState({ search: "词" });
    await useField.getState().selectDomain("d-2");
    expect(useField.getState().searchCarried).toBe(false);
  });
});
