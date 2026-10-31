import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperDetail, PaperListItem } from "./lib/types";
import { DEFAULT_ARCHIVE_VIEW, useField } from "./store";

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
    listPendingMineru: vi.fn(async () => [] as string[]),
    createDomain: vi.fn(),
    updatePaper: vi.fn(async () => undefined),
    movePapers: vi.fn(async () => undefined),
    applyTagsToPapers: vi.fn(async () => undefined),
    paperIdsInDomain: vi.fn(async () => [] as string[]),
    deleteDomain: vi.fn(async () => undefined),
    migrateDomainPapers: vi.fn(async () => 0),
    searchStructured: vi.fn(async () => [] as import("./lib/types").PaperListItem[]),
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
  vi.mocked(repo.listPendingMineru).mockReset();
  vi.mocked(repo.setReadingStatus).mockReset();
  vi.mocked(repo.setMineruState).mockReset();
  vi.mocked(repo.createDomain).mockReset();
  vi.mocked(repo.updatePaper).mockClear();
  vi.mocked(repo.movePapers).mockClear();
  vi.mocked(repo.paperIdsInDomain).mockReset();
  vi.mocked(repo.deleteDomain).mockClear();
  vi.mocked(repo.migrateDomainPapers).mockReset();
  vi.mocked(repo.applyTagsToPapers).mockClear();
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

  it("retryHistoryJob：按作业类型分派，AI 类一律 overwrite=false", async () => {
    const draft = vi.fn(async () => undefined);
    const prepare = vi.fn(async () => undefined);
    useField.setState({ runDraftNotes: draft, runPrepareMeta: prepare });

    await useField.getState().retryHistoryJob("p1", "draftNotes");
    await useField.getState().retryHistoryJob("p2", "prepareMeta");
    await useField.getState().retryHistoryJob("p3", "mineruParse");

    expect(draft).toHaveBeenCalledWith("p1", false);
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

  it("tryParseOnePaper：只取最早一篇待解析论文单独提交", async () => {
    vi.mocked(repo.listPendingMineru).mockResolvedValue(["p-first", "p-second"]);
    useField.setState({ mineru: configuredMineru });

    await useField.getState().tryParseOnePaper();

    expect(repo.resetMineru).toHaveBeenCalledWith(["p-first"]);
    expect(useField.getState().flash?.text).toContain("已将 1 篇重新发送到 MinerU 解析");
  });

  it("tryParseOnePaper：没有待解析论文时给导入指引", async () => {
    vi.mocked(repo.listPendingMineru).mockResolvedValue([]);
    vi.mocked(repo.resetMineru).mockClear();

    await useField.getState().tryParseOnePaper();

    expect(useField.getState().flash?.tone).toBe("warn");
    expect(useField.getState().flash?.text).toContain("没有待解析的论文");
    expect(useField.getState().flash?.text).toContain("⌘N");
    expect(repo.resetMineru).not.toHaveBeenCalled();
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

  it("createDomainAndMove：一次完成建领域 + 移动（就地新建入口）", async () => {
    vi.mocked(repo.createDomain).mockResolvedValue({
      id: "d-world",
      name: "世界模型",
      code: "D-09",
      summary: null,
      sortOrder: 9,
      createdAt: "2024-06-01T00:00:00.000Z",
    });
    useField.setState({ dialog: "move-paper", dialogPaperId: "p-1", mode: "field", selectedDomainId: "d-1" });
    await useField.getState().createDomainAndMove("  世界模型 ", "p-1");
    expect(repo.createDomain).toHaveBeenCalledWith({ name: "世界模型", code: "" });
    expect(repo.updatePaper).toHaveBeenCalledWith("p-1", { domainId: "d-world" });
    // 移动完成后：对话框关闭、选中新领域（refresh 后列表为空 → 选中回落为空也符合语义）。
    expect(useField.getState().dialog).toBeNull();
  });

  it("createDomainAndMove：名称为空报「领域名称必填」，不建领域不移动", async () => {
    await expect(useField.getState().createDomainAndMove("  ", "p-1")).rejects.toThrow("领域名称必填");
    expect(repo.createDomain).not.toHaveBeenCalled();
    expect(repo.updatePaper).not.toHaveBeenCalled();
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

describe("批量操作（移动 / 标状态 / 标签）", () => {
  it("moveCheckedPapers：按打开对话框时冻结的勾选集移动，提示带目标领域名", async () => {
    const DOMAINS = [
      { id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
      { id: "d-2", name: "指令对齐", code: "AL-02", summary: null, sortOrder: 2, createdAt: "2024-01-02T00:00:00.000Z" },
    ];
    // refresh 会用 repo.listDomains 的返回覆盖 store：让 mock 返回同一份领域。
    vi.mocked(repo.listDomains).mockResolvedValue(DOMAINS);
    useField.setState({
      mode: "field",
      selectedDomainId: "d-1",
      domains: DOMAINS,
      batchMode: true,
      checkedPaperIds: ["a", "b", "x"],
    });
    useField.getState().openDialog("move-checked");
    // 打开后后台把勾选改成别的：本批不受影响。
    useField.setState({ checkedPaperIds: ["z"] });
    await useField.getState().moveCheckedPapers("d-2");
    expect(repo.movePapers).toHaveBeenCalledWith(["a", "b", "x"], "d-2");
    expect(useField.getState().dialog).toBeNull();
    expect(useField.getState().flash?.tone).toBe("ok");
    expect(useField.getState().flash?.text).toContain("已将 3 篇论文移动到「指令对齐」");
  });

  it("setCheckedReadingStatus：逐篇写库并汇总提示（用户批量入口，非 AI）", async () => {
    useField.setState({ mode: "field", checkedPaperIds: ["a", "b"] });
    await useField.getState().setCheckedReadingStatus("read");
    expect(repo.setReadingStatus).toHaveBeenCalledTimes(2);
    expect(repo.setReadingStatus).toHaveBeenCalledWith("a", "read");
    expect(repo.setReadingStatus).toHaveBeenCalledWith("b", "read");
    expect(useField.getState().flash?.text).toContain("已将 2 篇论文标为已读");
  });

  it("addTagsToChecked / removeTagsFromChecked：作用于冻结集并给汇总提示", async () => {
    useField.setState({ checkedPaperIds: ["a", "b"] });
    useField.getState().openDialog("tag-checked");
    await useField.getState().addTagsToChecked(["综述", "综述", " "]);
    expect(repo.applyTagsToPapers).toHaveBeenCalledWith(["a", "b"], ["综述"], "add");
    expect(useField.getState().flash?.text).toContain("已为 2 篇论文添加标签：综述");

    // add 之后 refresh 把勾选裁剪到（空的）可见列表：重新勾选再开对话框。
    useField.setState({ checkedPaperIds: ["a", "b"] });
    useField.getState().openDialog("tag-checked");
    await useField.getState().removeTagsFromChecked(["综述"]);
    expect(repo.applyTagsToPapers).toHaveBeenCalledWith(["a", "b"], ["综述"], "remove");
  });
});

describe("每领域记住搜索、选中与列表位置（domainSpot）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function domainsFixture() {
    return [
      { id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
      { id: "d-2", name: "指令对齐", code: "AL-02", summary: null, sortOrder: 2, createdAt: "2024-01-02T00:00:00.000Z" },
    ];
  }

  it("离开领域时保存现场；切回时恢复搜索词与选中（论文仍在列表里才恢复）", async () => {
    const paperA = { ...listItem("a"), domainId: "d-1" };
    const paperB = { ...listItem("b"), domainId: "d-2" };
    vi.mocked(repo.listDomains).mockResolvedValue(domainsFixture());
    vi.mocked(repo.listPapers).mockImplementation(async (domainId: string) =>
      domainId === "d-1" ? [paperA] : [paperB],
    );
    useField.setState({ mode: "field", selectedDomainId: "d-1", domains: domainsFixture(), search: "clip", selectedPaperId: "a" });
    await useField.getState().selectDomain("d-2");
    // 切走后现场已存：d-1 的搜索词与选中论文
    const spot = JSON.parse(localStorage.getItem("paper-field.domain-spot")!) as Record<string, { search: string; paperId: string | null }>;
    expect(spot["d-1"].search).toBe("clip");
    expect(spot["d-1"].paperId).toBe("a");
    // 进入 d-2：不沿用 d-1 的搜索条件
    expect(useField.getState().search).toBe("");
    expect(useField.getState().restoredSearchFor).toBeNull();

    // d-2 自己留过现场：搜索与选中恢复
    await useField.getState().setSearch("rlhf");
    await useField.getState().selectPaper("b");
    await useField.getState().selectDomain("d-1");
    expect(useField.getState().search).toBe("clip");
    expect(useField.getState().restoredSearchFor).toBe("d-1");
    await useField.getState().selectDomain("d-2");
    expect(useField.getState().search).toBe("rlhf");
    expect(useField.getState().selectedPaperId).toBe("b");
  });

  it("切回时现场里的论文已不在列表（被删/被移走）：选中回落，搜索仍恢复", async () => {
    const paperA = { ...listItem("a"), domainId: "d-1" };
    vi.mocked(repo.listDomains).mockResolvedValue(domainsFixture());
    vi.mocked(repo.listPapers).mockResolvedValue([paperA]);
    localStorage.setItem(
      "paper-field.domain-spot",
      JSON.stringify({ "d-1": { search: "clip", paperId: "ghost", listTop: 40, at: 1 } }),
    );
    useField.setState({ mode: "field", selectedDomainId: "d-2", domains: domainsFixture() });
    await useField.getState().selectDomain("d-1");
    expect(useField.getState().search).toBe("clip");
    expect(useField.getState().selectedPaperId).toBe("a"); // refresh reselect 回落第一篇
  });
});

describe("migrateDomainThenDelete（迁移后删除）", () => {
  it("先取消在途作业，迁移论文到目标领域，删除旧领域并切到目标领域", async () => {
    const DOMAINS = [
      { id: "d-1", name: "旧领域", code: "D-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
      { id: "d-2", name: "收留领域", code: "D-02", summary: null, sortOrder: 2, createdAt: "2024-01-02T00:00:00.000Z" },
    ];
    vi.mocked(repo.listDomains).mockResolvedValue(DOMAINS);
    vi.mocked(repo.paperIdsInDomain).mockResolvedValue(["p1", "p2"]);
    vi.mocked(repo.migrateDomainPapers).mockResolvedValue(2);
    useField.setState({
      mode: "field",
      selectedDomainId: "d-1",
      domains: DOMAINS,
      selectedPaperId: "p1",
    });
    await useField.getState().migrateDomainThenDelete("d-2");
    expect(repo.migrateDomainPapers).toHaveBeenCalledWith("d-1", "d-2");
    expect(repo.deleteDomain).toHaveBeenCalledWith("d-1");
    expect(useField.getState().selectedDomainId).toBe("d-2");
    expect(useField.getState().flash?.text).toContain("已把 2 篇论文迁入「收留领域」");
  });

  it("目标是当前领域时不动作", async () => {
    useField.setState({ selectedDomainId: "d-1" });
    await useField.getState().migrateDomainThenDelete("d-1");
    expect(repo.migrateDomainPapers).not.toHaveBeenCalled();
    expect(repo.deleteDomain).not.toHaveBeenCalled();
  });
});

describe("结构化检索（tag:/domain:/year: 走 searchStructured）", () => {
  it("搜索词带 tag: 前缀时走 repo.searchStructured；普通词走 listPapers", async () => {
    vi.mocked(repo.listPapers).mockResolvedValue([]);
    const searchStructured = repo.searchStructured as ReturnType<typeof vi.fn>;
    searchStructured.mockResolvedValue([]);
    useField.setState({ mode: "field", selectedDomainId: "d-1", search: "" });
    await useField.getState().setSearch("clip");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(searchStructured).not.toHaveBeenCalled();
    useField.setState({ search: "" });
    await useField.getState().setSearch("tag:clip");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(searchStructured).toHaveBeenCalledWith(expect.objectContaining({ tags: ["clip"] }));
  });
});

describe("归档筛选记住上次选择（本机 localStorage）", () => {
  beforeEach(() => {
    localStorage.removeItem("paper-field.archive-view");
  });

  it("setArchiveFilter / setArchiveView 写入 localStorage；applySavedArchiveView 恢复并剔除已删领域", async () => {
    await useField.getState().setArchiveFilter("open");
    useField.getState().setArchiveView({ year: 2024, sort: "title", notesIncomplete: true, domainId: "d-9" });
    const raw = localStorage.getItem("paper-field.archive-view");
    expect(raw).toContain('"openSource":"open"');
    expect(raw).toContain('"year":2024');

    // 状态重置后恢复：开源档与视图回来；记住的领域已不在领域表里则剔除。
    useField.setState({ archiveFilter: "all", archiveView: DEFAULT_ARCHIVE_VIEW });
    useField.getState().applySavedArchiveView([
      { id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "now" },
    ]);
    expect(useField.getState().archiveFilter).toBe("open");
    expect(useField.getState().archiveView.year).toBe(2024);
    expect(useField.getState().archiveView.sort).toBe("title");
    expect(useField.getState().archiveView.notesIncomplete).toBe(true);
    expect(useField.getState().archiveView.domainId).toBeNull();
  });

  it("坏数据整包丢弃：applySavedArchiveView 不动现有状态", () => {
    localStorage.setItem("paper-field.archive-view", "{oops");
    useField.setState({ archiveFilter: "closed", archiveView: DEFAULT_ARCHIVE_VIEW });
    useField.getState().applySavedArchiveView();
    expect(useField.getState().archiveFilter).toBe("closed");
  });
});
