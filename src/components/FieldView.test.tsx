import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperListItem } from "../lib/types";
import { resetActivity, trackJob } from "../lib/activity";
import { repo } from "../lib/repo";
import { deferredPaperIds } from "../lib/deferredPapers";
import { readNextList } from "../lib/readNext";
import { useField } from "../store";
import { PaperNav } from "./FieldView";

function intakeItem(id: string, mineruStatus: PaperListItem["mineruStatus"]): PaperListItem {
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
    pdfPath: `/papers/${id}.pdf`,
    codeUrl: null,
    codeOpenSource: "unknown",
    projectPage: null,
    readingStatus: "unread",
    readAt: null,
    llmPreparedAt: null,
    notesDraftedByLlm: false,
    userNotesTouched: false,
    userMetaTouched: false,
    mineruStatus,
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

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
  resetActivity();
});

describe("PaperNav · 入库文案", () => {
  it("说明以未手动标为已读起句，进度旁不再写未读完", () => {
    useField.setState({ mode: "intake", intake: [] });
    render(<PaperNav />);
    expect(screen.getByRole("heading", { name: "入库" })).toBeInTheDocument();
    const summary = document.querySelector(".ef-nav-sum");
    expect(summary?.textContent?.startsWith("未手动标为已读")).toBe(true);
    expect(summary?.textContent).not.toContain("尚未读完");
    expect(screen.getByText("全部领域 · 未手动标为已读")).toBeInTheDocument();
    expect(screen.queryByText(/未读完/)).toBeNull();
  });
});

describe("PaperNav · INTAKE 漏斗统计与批量重试入口", () => {
  function todayItem(id: string, mineruStatus: PaperListItem["mineruStatus"]): PaperListItem {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return {
      ...intakeItem(id, mineruStatus),
      createdAt: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T09:00:00.000`,
    };
  }

  it("有解析失败论文时漏斗显示失败计数，「全部重试」打开影响预览对话框", () => {
    useField.setState({
      mode: "intake",
      intake: [intakeItem("a", "error"), intakeItem("b", "error"), intakeItem("c", "done")],
    });

    render(<PaperNav />);
    const funnel = document.querySelector(".ef-intake-funnel");
    expect(funnel?.textContent).toContain("解析中 0");
    expect(funnel?.textContent).toContain("待读 1");
    expect(funnel?.textContent).toContain("失败 2");
    expect(funnel?.textContent).toContain("全库待处理 3 · 当前命中 3");

    fireEvent.click(screen.getByRole("button", { name: "全部重试" }));
    expect(useField.getState().dialog).toBe("confirm-retry");
  });

  it("入库批量模式提供「重试所选」：只计勾选中解析失败/尚未提交的篇数并直接重试", async () => {
    const retryMineruPapers = vi.fn(async () => undefined);
    useField.setState({
      mode: "intake",
      intake: [intakeItem("a", "error"), intakeItem("b", "error"), intakeItem("c", "done"), intakeItem("d", "pending")],
      batchMode: true,
      checkedPaperIds: ["a", "c", "d"],
      retryMineruPapers,
    });
    render(<PaperNav />);
    // 勾选 a(error) c(done) d(pending)：可重试的是 a、d 两篇。
    const button = screen.getByRole("button", { name: "重试所选（2）" });
    fireEvent.click(button);
    await waitFor(() => {
      expect(retryMineruPapers).toHaveBeenCalledWith(["a", "d"]);
    });
  });

  it("漏斗计数可点即筛选：失败计数进入失败分组", () => {
    useField.setState({ mode: "intake", intake: [intakeItem("a", "error"), intakeItem("c", "done")] });
    const { rerender } = render(<PaperNav />);
    fireEvent.click(screen.getByRole("button", { name: "失败 1" }));
    rerender(<PaperNav />);
    expect(useField.getState().intakeStage).toBe("error");
    expect(document.querySelectorAll(".ef-row")).toHaveLength(1);
    expect(document.querySelector(".ef-intake-funnel")?.textContent).toContain("当前命中 1");
  });

  it("今日导入按本地自然日计数", () => {
    useField.setState({
      mode: "intake",
      intake: [todayItem("a", "done"), todayItem("b", "error"), intakeItem("old", "done")],
    });
    render(<PaperNav />);
    expect(document.querySelector(".ef-intake-funnel")?.textContent).toContain("今日导入 2");
  });

  it("没有失败论文时不显示「全部重试」", () => {
    useField.setState({
      mode: "intake",
      intake: [intakeItem("c", "done")],
    });

    render(<PaperNav />);
    expect(screen.queryByRole("button", { name: "全部重试" })).toBeNull();
  });
});

describe("PaperNav · INTAKE 任务列表只显示进行中的作业", () => {
  function job(id: string, status: "queued" | "running" | "done" | "error" | "cancelled") {
    return {
      id,
      paperId: "p-1",
      type: "mineruParse" as const,
      status,
      prompt: null,
      resultJson: null,
      error: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    };
  }

  it("完成的作业不再堆在列表里，进行中的照常显示", () => {
    useField.setState({
      mode: "intake",
      intake: [],
      jobs: [
        job("j1", "done"),
        job("j2", "running"),
        job("j3", "queued"),
        job("j4", "error"),
        job("j5", "cancelled"),
      ],
    });

    render(<PaperNav />);
    expect(screen.getByText(/MinerU 解析 · 运行中/)).toBeInTheDocument();
    expect(screen.getByText(/MinerU 解析 · 等待/)).toBeInTheDocument();
    // 断言限定在作业列表里：头部漏斗行合法地包含「失败 N」计数。
    const jobList = document.querySelector<HTMLElement>(".ef-job-list")!;
    expect(within(jobList).queryByText(/完成/)).toBeNull();
    expect(within(jobList).queryByText(/失败/)).toBeNull();
    expect(within(jobList).queryByText(/已取消/)).toBeNull();
  });

  it("没有进行中作业时显示空态文案", () => {
    useField.setState({ mode: "intake", intake: [], jobs: [job("j1", "done")] });
    render(<PaperNav />);
    expect(screen.getByText("当前没有进行中的 AI 作业。")).toBeInTheDocument();
  });

  it("作业行带论文标题与阶段一句话（与面板同口径），点击在面板高亮对应卡", () => {
    const highlightJob = vi.fn();
    trackJob("j1", "p-1", "parse", { provider: "api", pages: { done: 3, total: 10 } });
    useField.setState({
      mode: "intake",
      intake: [],
      highlightJob,
      jobs: [{ ...job("j1", "running"), paperTitle: "Attention Is All You Need", paperTitleZh: null }],
    });

    render(<PaperNav />);
    expect(screen.getByText("Attention Is All You Need")).toBeInTheDocument();
    // 阶段一句话与作业面板同一来源（含解析源与页进度）。
    expect(screen.getByText("已解析 3 / 10 页")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Attention Is All You Need/ }));
    expect(highlightJob).toHaveBeenCalledWith("j1");
  });

  it("进行中作业超过 6 条时可就地展开，不必跳作业面板", () => {
    useField.setState({
      mode: "intake",
      intake: [],
      jobs: Array.from({ length: 8 }, (_, i) => job(`j${i}`, "running")),
    });

    render(<PaperNav />);
    expect(screen.getByRole("button", { name: "另有 2 条进行中作业 · 就地展开" })).toBeInTheDocument();
    expect(document.querySelectorAll(".ef-job-row-main")).toHaveLength(6);

    fireEvent.click(screen.getByRole("button", { name: "另有 2 条进行中作业 · 就地展开" }));
    expect(document.querySelectorAll(".ef-job-row-main")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "收起进行中作业" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "收起进行中作业" }));
    expect(document.querySelectorAll(".ef-job-row-main")).toHaveLength(6);
  });
});

describe("PaperNav · 归档筛选、分组与排序", () => {
  function archiveItem(
    id: string,
    domainId: string,
    year: number | null,
    readAt: string | null,
    notesRevisedAt?: string,
  ): PaperListItem {
    return {
      ...intakeItem(id, null),
      domainId,
      readingStatus: "read" as const,
      readAt,
      year,
      notesRevisedAt: notesRevisedAt ?? null,
      domainName: domainId === "d-1" ? "多模态" : "指令对齐",
      domainCode: domainId === "d-1" ? "MM-01" : "IA-02",
      titleZh: null,
      title: `Paper ${id}`,
    };
  }

  const domains = [
    { id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
    { id: "d-2", name: "指令对齐", code: "IA-02", summary: null, sortOrder: 2, createdAt: "2024-01-01T00:00:00.000Z" },
  ];

  function archiveOf(): PaperListItem[] {
    return [
      archiveItem("a", "d-1", 2023, "2026-01-05T00:00:00.000Z", "2026-02-01T00:00:00.000Z"),
      archiveItem("b", "d-2", 2024, "2026-03-05T00:00:00.000Z"),
      archiveItem("c", "d-1", null, "2026-02-05T00:00:00.000Z", "2026-03-01T00:00:00.000Z"),
    ];
  }

  it("领域与年份组合筛选：只显示同时满足的行，计数跟随可见列表", () => {
    useField.setState({ mode: "archive", domains, archive: archiveOf() });
    const { rerender } = render(<PaperNav />);
    expect(document.querySelectorAll(".ef-row")).toHaveLength(3);

    fireEvent.change(screen.getByLabelText("按领域筛选归档"), { target: { value: "d-2" } });
    rerender(<PaperNav />);
    expect(document.querySelectorAll(".ef-row")).toHaveLength(1);
    expect(document.querySelector(".ef-count")?.textContent).toBe("01");

    fireEvent.change(screen.getByLabelText("按发表年份筛选归档"), { target: { value: "2023" } });
    rerender(<PaperNav />);
    expect(screen.getByText("没有符合条件的已读论文。可以调整上方的领域 / 年份筛选或开源状态。")).toBeInTheDocument();
  });

  it("排序：标题 / 最近改笔记 / 标记最久各有正确顺序", () => {
    useField.setState({
      mode: "archive",
      domains,
      archive: [
        archiveItem("b", "d-1", 2023, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
        archiveItem("a", "d-1", 2024, "2026-03-01T00:00:00.000Z"),
        archiveItem("c", "d-1", 2022, "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"),
      ],
    });
    const { rerender } = render(<PaperNav />);
    const titles = () => [...document.querySelectorAll(".ef-row h3")].map((node) => node.textContent);

    // 默认按最近已读（readAt 降序）。
    expect(titles()).toEqual(["Paper a", "Paper c", "Paper b"]);

    fireEvent.change(screen.getByLabelText("归档排序方式"), { target: { value: "title" } });
    rerender(<PaperNav />);
    expect(titles()).toEqual(["Paper a", "Paper b", "Paper c"]);

    fireEvent.change(screen.getByLabelText("归档排序方式"), { target: { value: "notes-recent" } });
    rerender(<PaperNav />);
    expect(titles()).toEqual(["Paper c", "Paper b", "Paper a"]);

    fireEvent.change(screen.getByLabelText("归档排序方式"), { target: { value: "oldest-read" } });
    rerender(<PaperNav />);
    expect(titles()).toEqual(["Paper b", "Paper c", "Paper a"]);
  });

  it("按领域分组：组头带领域与已读数，点击折叠该组", () => {
    useField.setState({ mode: "archive", domains, archive: archiveOf() });
    const { rerender } = render(<PaperNav />);
    fireEvent.click(screen.getByRole("button", { name: "按领域分组" }));
    rerender(<PaperNav />);

    const head = screen.getByRole("button", { name: "折叠领域分组：多模态" });
    expect(head).toHaveTextContent("多模态");
    expect(head).toHaveTextContent("已读 2 篇");
    expect(screen.getByRole("button", { name: /折叠领域分组：指令对齐/ })).toHaveTextContent("已读 1 篇");
    expect(document.querySelectorAll(".ef-row")).toHaveLength(3);

    fireEvent.click(head);
    rerender(<PaperNav />);
    expect(screen.getByRole("button", { name: "展开领域分组：多模态" })).toBeInTheDocument();
    // 多模态组折叠后只剩指令对齐组的 1 行。
    expect(document.querySelectorAll(".ef-row")).toHaveLength(1);
  });
  it("归档批量模式提供「对照表」入口：少于两篇禁用，两篇起打开对照表对话框", () => {
    useField.setState({
      mode: "archive",
      archive: [archiveItem("a", "d-1", 2023, "2026-01-01T00:00:00.000Z"), archiveItem("b", "d-1", 2024, "2026-02-01T00:00:00.000Z")],
      batchMode: true,
    });
    const { rerender } = render(<PaperNav />);
    const compare = screen.getByRole("button", { name: "对照表" });
    expect(compare).toBeDisabled();

    useField.setState({ checkedPaperIds: ["a"] });
    rerender(<PaperNav />);
    expect(screen.getByRole("button", { name: "对照表" })).toBeDisabled();

    useField.setState({ checkedPaperIds: ["a", "b"] });
    rerender(<PaperNav />);
    fireEvent.click(screen.getByRole("button", { name: "对照表" }));
    expect(useField.getState().dialog).toBe("compare-notes");
    // 打开时冻结勾选集。
    expect(useField.getState().dialogPaperIds).toEqual(["a", "b"]);
  });

  it("「笔记未写满」筛选：只留五块未写满的行，行内显示笔记 x/5", () => {
    useField.setState({
      mode: "archive",
      domains,
      archive: [
        { ...archiveItem("a", "d-1", 2023, "2026-01-01T00:00:00.000Z"), notesFilled: 5 },
        { ...archiveItem("b", "d-1", 2024, "2026-02-01T00:00:00.000Z"), notesFilled: 3 },
      ],
    });
    const { rerender } = render(<PaperNav />);
    expect(document.querySelectorAll(".ef-row")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "笔记未写满" }));
    rerender(<PaperNav />);
    expect(useField.getState().archiveView.notesIncomplete).toBe(true);
    const rows = document.querySelectorAll(".ef-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("笔记 3/5");
  });

  it("搜索范围开关「含笔记」：切换写入视图态，命中显示行内片段", async () => {
    const noteSpy = vi
      .spyOn(repo, "noteHitExcerpts")
      .mockResolvedValue([{ paperId: "a", kind: "highlights", snippet: "…独特的暗号…" }]);
    vi.spyOn(repo, "fulltextHitExcerpts").mockResolvedValue([]);
    useField.setState({
      mode: "archive",
      domains,
      archive: [archiveItem("a", "d-1", 2023, "2026-01-01T00:00:00.000Z")],
      search: "暗号",
    });
    render(<PaperNav />);
    // 默认关闭：不发片段查询。
    expect(noteSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "含笔记" }));
    expect(useField.getState().archiveView.searchNotes).toBe(true);
    await waitFor(
      () => {
        expect(screen.getByText("笔记命中 · 亮点：…独特的暗号…")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
  });

  it("归档行内「重新在读」快捷动作：不改选中直接切阅读状态", () => {
    const setReadingStatus = vi.fn(async () => undefined);
    const selectPaper = vi.fn(async () => undefined);
    useField.setState({
      mode: "archive",
      domains,
      archive: archiveOf(),
      setReadingStatus,
      selectPaper,
    });
    render(<PaperNav />);
    const buttons = screen.getAllByRole("button", { name: "重新在读" });
    expect(buttons.length).toBeGreaterThan(0);
    fireEvent.click(buttons[0]);
    expect(setReadingStatus).toHaveBeenCalledWith("reading", expect.any(String));
    // 快捷动作不打开论文。
    expect(selectPaper).not.toHaveBeenCalled();
  });

  it("归档批量模式「导出所选」：无勾选禁用，有勾选打开导出对话框并冻结勾选集", () => {
    useField.setState({
      mode: "archive",
      archive: [archiveItem("a", "d-1", 2023, "2026-01-01T00:00:00.000Z"), archiveItem("b", "d-1", 2024, "2026-02-01T00:00:00.000Z")],
      batchMode: true,
    });
    const { rerender } = render(<PaperNav />);
    expect(screen.getByRole("button", { name: "导出所选" })).toBeDisabled();

    useField.setState({ checkedPaperIds: ["a", "b"] });
    rerender(<PaperNav />);
    fireEvent.click(screen.getByRole("button", { name: "导出所选" }));
    expect(useField.getState().dialog).toBe("export-checked");
    expect(useField.getState().dialogPaperIds).toEqual(["a", "b"]);
  });

  it("现场模式批量工具栏不提供「对照表」", () => {
    useField.setState({ mode: "field", papers: [intakeItem("a", null)], batchMode: true });
    render(<PaperNav />);
    expect(screen.queryByRole("button", { name: "对照表" })).toBeNull();
  });
  it("归档行显示领域徽标与「在所属领域中打开」：徽标筛选该领域（再点取消），直达进入现场", async () => {
    const selectDomain = vi.fn(async () => undefined);
    const selectPaper = vi.fn(async () => undefined);
    useField.setState({ mode: "archive", domains, archive: archiveOf(), selectDomain, selectPaper });
    const { rerender } = render(<PaperNav />);

    const badge = screen.getAllByRole("button", { name: "只看领域 多模态 的已读论文" })[0];
    expect(badge).toHaveTextContent("MM-01");
    fireEvent.click(badge);
    rerender(<PaperNav />);
    expect(useField.getState().archiveView.domainId).toBe("d-1");
    expect(document.querySelectorAll(".ef-row")).toHaveLength(2);
    // 激活的徽标再点一次取消筛选，回到全部领域。
    fireEvent.click(screen.getAllByRole("button", { name: "只看领域 多模态 的已读论文" })[0]);
    rerender(<PaperNav />);
    expect(useField.getState().archiveView.domainId).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /在所属领域中打开/ })[0]);
    });
    // 默认按最近已读排序，第一行是 readAt 最新的 b（领域 d-2）。
    expect(selectDomain).toHaveBeenCalledWith("d-2");
    expect(selectPaper).toHaveBeenCalledWith("b");
    expect(useField.getState().flash?.text).toContain("已在所属领域中打开");
  });

  it("现场模式行不带领域徽标与直达入口", () => {
    useField.setState({ mode: "field", papers: [intakeItem("a", null)] });
    render(<PaperNav />);
    expect(screen.queryByRole("button", { name: /只看领域/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /在所属领域中打开/ })).toBeNull();
  });
});

describe("PaperNav · 阅读成果统计卡与归档空态指引", () => {
  function readAtItem(id: string, readAt: string, domainName = "多模态"): PaperListItem {
    return { ...intakeItem(id, null), readingStatus: "read" as const, readAt, domainName };
  }

  function localIso(date: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T09:00:00.000`;
  }

  it("显示本周 / 本月 / 连续阅读与今年回顾，可安静关闭（本机记住）", () => {
    localStorage.removeItem("paper-field.archive-stats-dismissed");
    const now = new Date();
    const daysAgo = (n: number) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 9);
      return localIso(d);
    };
    useField.setState({
      mode: "archive",
      archive: [readAtItem("a", daysAgo(0)), readAtItem("b", daysAgo(1))],
    });
    render(<PaperNav />);
    const card = document.querySelector(".ef-archive-stats");
    expect(card).toBeTruthy();
    // 周界随星期几漂移，只断言标签；连续阅读（今天+昨天）与今年口径是确定的。
    expect(card?.textContent).toContain("本周已读");
    expect(card?.textContent).toContain("本月已读");
    expect(card?.textContent).toContain("连续阅读 2 天");
    expect(card?.textContent).toContain("今年已读 2 篇");
    expect(card?.textContent).toContain("最常读 多模态");
    expect(card?.querySelectorAll(".ef-stats-spark i")).toHaveLength(12);

    fireEvent.click(screen.getByRole("button", { name: "关闭阅读成果统计（不再显示）" }));
    expect(document.querySelector(".ef-archive-stats")).toBeNull();
    expect(localStorage.getItem("paper-field.archive-stats-dismissed")).toBe("1");
    localStorage.removeItem("paper-field.archive-stats-dismissed");
  });

  it("空归档给出三步指引与下一步入口：去读第一篇 / 去入库看看", async () => {
    localStorage.removeItem("paper-field.archive-stats-dismissed");
    const selectDomain = vi.fn(async () => undefined);
    const selectPaper = vi.fn(async () => undefined);
    const setMode = vi.fn(async () => undefined);
    useField.setState({
      mode: "archive",
      archive: [],
      intake: [intakeItem("p1", "done")],
      selectDomain,
      selectPaper,
      setMode,
    });
    render(<PaperNav />);
    expect(screen.getByText(/在「现场」或「入库」打开一篇论文/)).toBeInTheDocument();
    expect(screen.getByText(/把阅读状态改为「已读」/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "去读第一篇" }));
    });
    expect(selectDomain).toHaveBeenCalledWith("d-1");
    expect(selectPaper).toHaveBeenCalledWith("p1");

    fireEvent.click(screen.getByRole("button", { name: "去入库看看" }));
    expect(setMode).toHaveBeenCalledWith("intake");
  });

  it("库里完全没有论文时「去读第一篇」禁用", () => {
    useField.setState({ mode: "archive", archive: [], intake: [], papers: [] });
    render(<PaperNav />);
    expect(screen.getByRole("button", { name: "去读第一篇" })).toBeDisabled();
  });
});

describe("PaperNav · 入库按解析状态分组（失败置顶）", () => {
  it("chips 带计数：点击只留该状态；失败永远排在最前", () => {
    useField.setState({
      mode: "intake",
      intake: [
        intakeItem("a", "done"),
        intakeItem("b", "error"),
        intakeItem("c", "parsing"),
        intakeItem("d", "queued"),
        intakeItem("e", "pending"),
        intakeItem("f", null),
      ],
    });
    const { rerender } = render(<PaperNav />);
    const chips = document.querySelector('[aria-label="按解析状态分组"]');
    expect(chips?.textContent).toContain("全部 6");
    expect(chips?.textContent).toContain("解析失败 1");
    expect(chips?.textContent).toContain("解析中 1");
    expect(chips?.textContent).toContain("排队中 1");
    expect(chips?.textContent).toContain("待解析 1");
    expect(chips?.textContent).toContain("已解析待读 2");

    // 失败置顶：error 行出现在 done 行之前。
    const titles = () => [...document.querySelectorAll(".ef-row h3")].map((n) => n.textContent);
    expect(titles().indexOf("论文 b")).toBeLessThan(titles().indexOf("论文 a"));

    // 点「已解析待读」：只剩 done 与无 PDF 条目。
    fireEvent.click(screen.getByRole("button", { name: "已解析待读 2" }));
    rerender(<PaperNav />);
    expect(document.querySelectorAll(".ef-row")).toHaveLength(2);
    expect(useField.getState().intakeStage).toBe("ready");

    // 空筛选给可行动文案。
    fireEvent.click(screen.getByRole("button", { name: "排队中 1" }));
    useField.setState({ intake: useField.getState().intake.filter((p) => p.mineruStatus !== "queued") });
    rerender(<PaperNav />);
    expect(screen.getByText("当前筛选下没有论文。可以切换上方的解析状态分组或调整搜索词。")).toBeInTheDocument();
  });

  it("空入库不渲染分组行", () => {
    useField.setState({ mode: "intake", intake: [] });
    render(<PaperNav />);
    expect(document.querySelector('[aria-label="按解析状态分组"]')).toBeNull();
  });
});

describe("PaperNav · 入库行组合状态标签", () => {
  function job(id: string, paperId: string, type: "prepareMeta", status: "running" | "queued" | "done") {
    return {
      id,
      paperId,
      type,
      status,
      prompt: null,
      resultJson: null,
      error: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    };
  }

  it("组合标签同时透出解析与补全两条流水线", () => {
    useField.setState({
      mode: "intake",
      intake: [
        { ...intakeItem("done-meta", "done"), llmPreparedAt: "2026-01-02T00:00:00.000Z" },
        intakeItem("done-wait", "done"),
        intakeItem("err", "error"),
        { ...intakeItem("noped", null), pdfPath: null },
      ],
      jobs: [job("j1", "done-wait", "prepareMeta", "running")],
    });
    render(<PaperNav />);
    expect(screen.getByText("解析完成 · 信息已补全")).toBeInTheDocument();
    expect(screen.getByText("解析完成 · 信息补全中")).toBeInTheDocument();
    expect(screen.getByText("解析失败 · 信息待补全")).toBeInTheDocument();
    expect(screen.getByText("无 PDF · 信息待补全")).toBeInTheDocument();
  });

  it("排队中的补全作业同样显示「信息补全中」", () => {
    useField.setState({
      mode: "intake",
      intake: [intakeItem("q", "done")],
      jobs: [job("j2", "q", "prepareMeta", "queued")],
    });
    render(<PaperNav />);
    expect(screen.getByText("解析完成 · 信息补全中")).toBeInTheDocument();
  });
});

describe("PaperNav · 失败原因可见与聚类", () => {
  function failedItem(id: string, error: string): PaperListItem {
    return { ...intakeItem(id, "error"), mineruError: error };
  }

  it("失败行显示类别与原因摘要（前 40 字），带单篇重试与查看解决办法", async () => {
    const retryMineru = vi.fn(async () => undefined);
    const openSystemCard = vi.fn();
    useField.setState({
      mode: "intake",
      intake: [failedItem("a", "A0202: invalid token"), intakeItem("ok", "done")],
      retryMineru,
      openSystemCard,
    });
    render(<PaperNav />);
    const reason = screen.getByText(/原因 · Token 问题：A0202: invalid token/);
    expect(reason).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => {
      expect(retryMineru).toHaveBeenCalledWith("a");
    });
    fireEvent.click(screen.getByRole("button", { name: "查看解决办法" }));
    expect(openSystemCard).toHaveBeenCalledWith("mineru");
  });

  it("失败计数可展开：按根因聚类分组，附建议、重试此类与查看解决办法", async () => {
    const retryMineruPapers = vi.fn(async () => undefined);
    const openSystemCard = vi.fn();
    useField.setState({
      mode: "intake",
      intake: [
        failedItem("a", "A0202: invalid token"),
        failedItem("b", "Token 过期"),
        failedItem("c", "error -60018 daily quota"),
      ],
      retryMineruPapers,
      openSystemCard,
    });
    render(<PaperNav />);
    expect(screen.queryByText(/Token 问题 · 2 篇/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看失败原因（3）" }));
    expect(screen.getByText("Token 问题 · 2 篇")).toBeInTheDocument();
    expect(screen.getByText("额度用尽 · 1 篇")).toBeInTheDocument();
    expect(screen.getByText(/Token 无效或已过期/)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "重试此类" })[0]);
    await waitFor(() => {
      expect(retryMineruPapers).toHaveBeenCalledWith(["a", "b"]);
    });
    fireEvent.click(screen.getAllByRole("button", { name: "查看解决办法" })[0]);
    expect(openSystemCard).toHaveBeenCalledWith("mineru");

    fireEvent.click(screen.getByRole("button", { name: "收起失败原因" }));
    expect(screen.queryByText(/Token 问题 · 2 篇/)).toBeNull();
  });
});

describe("PaperNav · 接下来读（建议与个人短队列）", () => {
  beforeEach(() => {
    localStorage.removeItem("paper-field.read-next");
  });

  function doneItem(id: string, createdAt: string): PaperListItem {
    return { ...intakeItem(id, "done"), createdAt };
  }

  it("下一篇建议 = 已解析完成里最早导入的一篇，可直接开始阅读", async () => {
    const openPaperFulltext = vi.fn(async () => undefined);
    useField.setState({
      mode: "intake",
      intake: [
        intakeItem("pending1", "pending"),
        doneItem("new", "2026-03-01T00:00:00.000Z"),
        doneItem("old", "2026-01-01T00:00:00.000Z"),
      ],
      openPaperFulltext,
    });
    render(<PaperNav />);
    expect(screen.getByText("下一篇建议")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始阅读" }));
    await waitFor(() => {
      expect(openPaperFulltext).toHaveBeenCalledWith("old");
    });
  });

  it("行内「+ 接下来读」入队，队列可置顶 / 移出，点标题开始阅读", async () => {
    const openPaperFulltext = vi.fn(async () => undefined);
    useField.setState({
      mode: "intake",
      intake: [doneItem("a", "2026-01-01T00:00:00.000Z"), doneItem("b", "2026-02-01T00:00:00.000Z"), doneItem("c", "2026-03-01T00:00:00.000Z")],
      openPaperFulltext,
    });
    render(<PaperNav />);
    // 建议卡一开始就有（论文都已解析），个人队列还没有。
    expect(screen.getByText("下一篇建议")).toBeInTheDocument();
    expect(screen.queryByText(/接下来读 · \d/)).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "+ 接下来读" })[0]);
    expect(localStorage.getItem("paper-field.read-next")).toContain('"a"');
    // a 入队后行内按钮变为「已在接下来读」，剩余 + 按钮的首个是 b。
    fireEvent.click(screen.getAllByRole("button", { name: "+ 接下来读" })[0]);
    // 队列 a, b；置顶 b 后 b, a。
    fireEvent.click(screen.getByRole("button", { name: "置顶 论文 b" }));
    expect(readNextList()).toEqual(["b", "a"]);
    fireEvent.click(screen.getByRole("button", { name: "移出 论文 b" }));
    expect(readNextList()).toEqual(["a"]);

    fireEvent.click(screen.getByRole("button", { name: "论文 a" }));
    await waitFor(() => {
      expect(openPaperFulltext).toHaveBeenCalledWith("a");
    });
    localStorage.removeItem("paper-field.read-next");
  });
});

describe("PaperNav · 失败论文暂缓处理", () => {
  beforeEach(() => {
    localStorage.removeItem("paper-field.intake-deferred");
  });

  it("失败行「暂缓处理」后移出主列表、折叠到次要区，可恢复", () => {
    useField.setState({
      mode: "intake",
      intake: [intakeItem("a", "error"), intakeItem("b", "done")],
    });
    const { rerender } = render(<PaperNav />);
    fireEvent.click(screen.getByRole("button", { name: "暂缓处理" }));
    expect(deferredPaperIds()).toEqual(["a"]);

    rerender(<PaperNav />);
    // 主列表只剩 done；折叠区显示暂缓篇目与恢复按钮。
    const titles = [...document.querySelectorAll(".ef-row h3")].map((n) => n.textContent);
    expect(titles).toEqual(["论文 b"]);
    expect(screen.getByText("暂缓处理 · 1 篇")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "恢复处理" }));
    expect(deferredPaperIds()).toEqual([]);
    rerender(<PaperNav />);
    expect([...document.querySelectorAll(".ef-row h3")].map((n) => n.textContent)).toEqual(["论文 a", "论文 b"]);
    localStorage.removeItem("paper-field.intake-deferred");
  });

  it("没有暂缓篇目时不渲染折叠区", () => {
    useField.setState({ mode: "intake", intake: [intakeItem("a", "error")] });
    render(<PaperNav />);
    expect(screen.queryByText(/暂缓处理 · /)).toBeNull();
  });
});

describe("PaperNav · 入库组合筛选（领域/日期/解析源）", () => {
  function createdItem(id: string, createdAt: string, provider: string | null): PaperListItem {
    return { ...intakeItem(id, "done"), createdAt, mineruProvider: provider };
  }

  const domains = [
    { id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
    { id: "d-2", name: "指令对齐", code: "IA-02", summary: null, sortOrder: 2, createdAt: "2024-01-01T00:00:00.000Z" },
  ];

  it("领域 / 日期 / 解析源组合筛选与一键清空", () => {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T09:00:00.000`;
    const lastWeek = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate() - 10)}T09:00:00.000`;
    useField.setState({
      mode: "intake",
      domains,
      intake: [
        { ...createdItem("a", today, "local"), domainId: "d-1" },
        { ...createdItem("b", today, "api"), domainId: "d-2" },
        createdItem("c", lastWeek, null),
      ],
    });
    const { rerender } = render(<PaperNav />);
    expect(document.querySelectorAll(".ef-row")).toHaveLength(3);

    // d-1 有 a（今天）与 c（十天前）两篇。
    fireEvent.change(screen.getByLabelText("按领域筛选入库"), { target: { value: "d-1" } });
    rerender(<PaperNav />);
    expect(document.querySelectorAll(".ef-row")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("按入库日期筛选"), { target: { value: "today" } });
    fireEvent.change(screen.getByLabelText("按领域筛选入库"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("按解析源筛选"), { target: { value: "local" } });
    rerender(<PaperNav />);
    // 今天 + 本地 CLI → 只剩 a（c 十天前导入且无来源记录）。
    expect(document.querySelectorAll(".ef-row")).toHaveLength(1);

    // 清空条件回到全量（解析状态分组保留）。
    fireEvent.click(screen.getByRole("button", { name: "清空条件" }));
    rerender(<PaperNav />);
    expect(useField.getState().intakeView).toEqual({ domainId: null, period: "all", provider: "" });
    expect(document.querySelectorAll(".ef-row")).toHaveLength(3);
  });

  it("解析源下拉含「未记录来源」并可筛选", () => {
    useField.setState({
      mode: "intake",
      domains,
      intake: [createdItem("a", "2026-01-01T00:00:00.000Z", "local"), createdItem("b", "2026-01-02T00:00:00.000Z", null)],
    });
    const { rerender } = render(<PaperNav />);
    fireEvent.change(screen.getByLabelText("按解析源筛选"), { target: { value: "__none__" } });
    rerender(<PaperNav />);
    const titles = [...document.querySelectorAll(".ef-row h3")].map((n) => n.textContent);
    expect(titles).toEqual(["论文 b"]);
  });
});

describe("PaperNav · INTAKE 完成时刻与首次导入引导", () => {
  beforeEach(() => {
    localStorage.removeItem("paper-field.intake-guide-dismissed");
    localStorage.removeItem("paper-field.has-imported");
  });

  it("首次导入后显示引导卡：开始读第一篇 / 检查解析源 / 不再显示", () => {
    const openPaperFulltext = vi.fn(async () => undefined);
    const openSystemCard = vi.fn();
    useField.setState({
      mode: "intake",
      intake: [intakeItem("a", "done")],
      openPaperFulltext,
      openSystemCard,
    });
    const { rerender } = render(<PaperNav />);
    // 尚未导入过：不显示。
    expect(screen.queryByText(/第一次导入完成/)).toBeNull();

    localStorage.setItem("paper-field.has-imported", "1");
    rerender(<PaperNav />);
    expect(screen.getByText(/第一次导入完成/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "开始读第一篇" }));
    expect(openPaperFulltext).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: "检查解析源" }));
    expect(openSystemCard).toHaveBeenCalledWith("mineru");

    fireEvent.click(screen.getByRole("button", { name: "不再显示" }));
    rerender(<PaperNav />);
    expect(screen.queryByText(/第一次导入完成/)).toBeNull();
    expect(localStorage.getItem("paper-field.intake-guide-dismissed")).toBe("1");
  });

  it("全部清空时显示「队列已清空」与「去看已读归档」出口", async () => {
    const setMode = vi.fn(async () => undefined);
    useField.setState({ mode: "intake", intake: [], jobs: [], setMode });
    render(<PaperNav />);
    expect(screen.getByText(/队列已清空/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "去看已读归档" }));
    expect(setMode).toHaveBeenCalledWith("archive");
  });

  it("有作业进行中时不显示清空空态", () => {
    useField.setState({
      mode: "intake",
      intake: [],
      jobs: [
        {
          id: "j1",
          paperId: "p1",
          type: "mineruParse" as const,
          status: "running" as const,
          prompt: null,
          resultJson: null,
          error: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          startedAt: null,
          finishedAt: null,
        },
      ],
    });
    render(<PaperNav />);
    expect(screen.queryByText(/队列已清空/)).toBeNull();
  });
});

describe("PaperNav · 空闲区三类能力配置状态", () => {
  it("无进行中作业时逐行说明解析 / 文献库 / 模型的配置状态并链接设置卡", () => {
    const openSystemCard = vi.fn();
    useField.setState({
      mode: "intake",
      intake: [],
      jobs: [],
      mineru: { ...useField.getState().mineru, configured: true },
      biblio: { ...useField.getState().biblio, email: "" },
      settings: { version: 2, providers: [], usage: {} },
      openSystemCard,
    });
    render(<PaperNav />);
    const panel = document.querySelector(".ef-idle-capabilities")!;
    expect(panel.textContent).toContain("PDF 解析（MinerU）");
    expect(panel.textContent).toContain("已配置，首选 本地 CLI");
    expect(panel.textContent).toContain("未配置邮箱——不影响查询");
    expect(panel.textContent).toContain("未配置——著录与笔记仍可全手动录入");

    const buttons = [...panel.querySelectorAll("button")];
    fireEvent.click(buttons[1]!);
    expect(openSystemCard).toHaveBeenLastCalledWith("biblio");
  });

  it("有进行中作业时不渲染能力状态区", () => {
    useField.setState({
      mode: "intake",
      intake: [],
      jobs: [
        {
          id: "j1",
          paperId: "p1",
          type: "mineruParse" as const,
          status: "running" as const,
          prompt: null,
          resultJson: null,
          error: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          startedAt: null,
          finishedAt: null,
        },
      ],
    });
    render(<PaperNav />);
    expect(document.querySelector(".ef-idle-capabilities")).toBeNull();
  });
});

describe("PaperNav · 领域计数不随搜索改写", () => {
  it("搜索过滤列表，阅读进度和本领域论文仍按未过滤领域计算", () => {
    const read = { ...intakeItem("a", null), readingStatus: "read" as const };
    const unread = intakeItem("b", null);
    useField.setState({
      mode: "field",
      selectedDomainId: "d-1",
      papers: [read, unread],
      search: "",
    });
    const { rerender } = render(<PaperNav />);
    expect(document.querySelector(".ef-progress-value")?.textContent?.replace(/\s+/g, " ")).toBe("已读 1 / 2");
    expect(document.querySelector(".ef-count")?.textContent).toBe("02");

    useField.setState({ papers: [], search: "没有这篇文章xyz" });
    rerender(<PaperNav />);
    expect(screen.getByText("没有符合条件的论文。可以调整搜索词或切换领域。")).toBeInTheDocument();
    expect(document.querySelector(".ef-progress-value")?.textContent?.replace(/\s+/g, " ")).toBe("已读 1 / 2");
    expect(document.querySelector(".ef-count")?.textContent).toBe("02");

    useField.setState({ papers: [read], search: "视觉指令" });
    rerender(<PaperNav />);
    expect(document.querySelector(".ef-progress-value")?.textContent?.replace(/\s+/g, " ")).toBe("已读 1 / 2");
    expect(document.querySelector(".ef-count")?.textContent).toBe("02");
  });

  it("空领域提示此领域还没有论文", () => {
    useField.setState({ mode: "field", papers: [], search: "" });
    render(<PaperNav />);
    expect(screen.getByText("此领域还没有论文。")).toBeInTheDocument();
  });
});

describe("PaperNav · 批量选择与批量删除", () => {
  it("列表非空时显示批量选择入口，空列表不显示", () => {
    useField.setState({ mode: "field", papers: [intakeItem("a", null)] });
    const { unmount } = render(<PaperNav />);
    expect(screen.getByRole("button", { name: "批量选择论文" })).toBeInTheDocument();
    unmount();

    useField.setState({ papers: [] });
    render(<PaperNav />);
    expect(screen.queryByRole("button", { name: "批量选择论文" })).toBeNull();
  });

  it("点击入口进入批量模式，行变为复选框；Esc 或「退出」退出并清空勾选", () => {
    useField.setState({ mode: "field", papers: [intakeItem("a", null), intakeItem("b", null)] });
    render(<PaperNav />);
    fireEvent.click(screen.getByRole("button", { name: "批量选择论文" }));
    expect(useField.getState().batchMode).toBe(true);
    expect(screen.getByRole("checkbox", { name: "全选" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /论文 a/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /论文 b/ })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useField.getState().batchMode).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "批量选择论文" }));
    useField.getState().toggleCheckedPaper("a");
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(useField.getState().batchMode).toBe(false);
    expect(useField.getState().checkedPaperIds).toEqual([]);
  });

  it("批量模式下点击行切换勾选，不再打开论文", () => {
    const selectPaper = vi.fn(async () => undefined);
    const toggleCheckedPaper = vi.fn();
    useField.setState({
      mode: "field",
      papers: [intakeItem("a", null)],
      batchMode: true,
      selectPaper,
      toggleCheckedPaper,
    });
    render(<PaperNav />);
    fireEvent.click(screen.getByRole("checkbox", { name: /论文 a/ }));
    expect(toggleCheckedPaper).toHaveBeenCalledWith("a");
    expect(selectPaper).not.toHaveBeenCalled();
  });

  it("全选在「全部勾选 / 全部清空」间切换", () => {
    useField.setState({
      mode: "field",
      papers: [intakeItem("a", null), intakeItem("b", null)],
      batchMode: true,
    });
    render(<PaperNav />);
    fireEvent.click(screen.getByRole("checkbox", { name: "全选" }));
    expect(useField.getState().checkedPaperIds).toEqual(["a", "b"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "全选" }));
    expect(useField.getState().checkedPaperIds).toEqual([]);
  });

  it("无勾选时删除禁用；有勾选时显示计数并打开确认对话框", () => {
    useField.setState({ mode: "field", papers: [intakeItem("a", null)], batchMode: true });
    const { rerender } = render(<PaperNav />);
    expect(screen.getByRole("button", { name: "删除" })).toBeDisabled();

    useField.setState({ checkedPaperIds: ["a"] });
    rerender(<PaperNav />);
    expect(screen.getByText("已选 1 / 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(useField.getState().dialog).toBe("delete-checked");
  });
});

describe("PaperNav · 领域标题与批量入口", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
  });

  it("领域标题整行是切换按钮，chevron 只是图标", () => {
    useField.setState({
      mode: "field",
      selectedDomainId: "d-1",
      domains: [
        {
          id: "d-1",
          name: "多模态",
          code: "MM-01",
          summary: "视觉",
          sortOrder: 1,
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      papers: [intakeItem("a", null)],
    });
    render(<PaperNav />);
    const picker = screen.getByRole("button", { name: "切换研究领域：多模态" });
    expect(picker).toHaveClass("ef-domain-picker");
    expect(picker.querySelector("h2")).toHaveTextContent("多模态");
    expect(picker.querySelector(".ef-domain-select")).toBeTruthy();
    expect(picker.querySelector("button")).toBeNull();
    fireEvent.click(picker);
    expect(useField.getState().dialog).toBe("pick-domain");
  });

  it("批量入口在图标旁显示「批量」", () => {
    useField.setState({ mode: "field", papers: [intakeItem("a", null)] });
    render(<PaperNav />);
    const toggle = screen.getByRole("button", { name: "批量选择论文" });
    expect(toggle).toHaveTextContent("批量");
  });
});

describe("PaperNav · 搜索与添加论文住在列表栏", () => {
  it.each(["field", "archive", "intake"] as const)("%s 模式在列表上方渲染搜索框", (mode) => {
    useField.setState({ mode });
    render(<PaperNav />);
    expect(screen.getByLabelText("搜索论文")).toBeInTheDocument();
  });

  it.each(["field", "intake"] as const)("%s 模式在列表底部提供「添加论文」，点击打开添加对话框", (mode) => {
    useField.setState({ mode });
    render(<PaperNav />);
    fireEvent.click(screen.getByRole("button", { name: /添加论文/ }));
    expect(useField.getState().dialog).toBe("paper");
  });

  it("归档页只列已读论文，不提供「添加论文」", () => {
    useField.setState({ mode: "archive" });
    render(<PaperNav />);
    expect(screen.queryByRole("button", { name: /添加论文/ })).toBeNull();
  });
});

describe("PaperNav · 标已读的 +1 微反馈", () => {
  it("readPulse 置位时：领域进度条与已读计数挂上脉冲类", () => {
    useField.setState({ mode: "field", papers: [intakeItem("p1", null), intakeItem("p2", null)], readPulse: 1 });
    render(<PaperNav />);
    expect(document.querySelector(".ef-progress")).toHaveClass("is-read-pulse");
    expect(document.querySelector(".ef-progress-value b")).toHaveClass("is-read-pulse");
  });

  it("无脉冲时进度条不带脉冲类", () => {
    useField.setState({ mode: "field", papers: [intakeItem("p1", null)] });
    render(<PaperNav />);
    expect(document.querySelector(".ef-progress")).not.toHaveClass("is-read-pulse");
  });
});
