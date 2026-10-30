import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperListItem } from "../lib/types";
import { resetActivity, trackJob } from "../lib/activity";
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

describe("PaperNav · INTAKE 批量重试入口", () => {
  it("有解析失败论文时显示计数与「全部重试」，点击触发批量重试", () => {
    const retryFailedMineru = vi.fn(async () => undefined);
    useField.setState({
      mode: "intake",
      intake: [intakeItem("a", "error"), intakeItem("b", "error"), intakeItem("c", "done")],
      retryFailedMineru,
    });

    render(<PaperNav />);
    expect(screen.getByText("解析失败 · 2 篇")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全部重试" }));
    expect(retryFailedMineru).toHaveBeenCalledTimes(1);
  });

  it("没有失败论文时不显示入口", () => {
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
    expect(screen.queryByText(/完成/)).toBeNull();
    expect(screen.queryByText(/失败/)).toBeNull();
    expect(screen.queryByText(/已取消/)).toBeNull();
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

  it("进行中作业超过 6 条时提示其余在作业面板查看", () => {
    useField.setState({
      mode: "intake",
      intake: [],
      jobs: Array.from({ length: 8 }, (_, i) => job(`j${i}`, "running")),
    });

    render(<PaperNav />);
    expect(screen.getByText(/另有 2 条进行中作业/)).toBeInTheDocument();
    expect(document.querySelectorAll(".ef-job-row-main")).toHaveLength(6);
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

  it("领域标题整行是切换按钮，chevron 只是图标；点击就地展开快捷切换下拉", () => {
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
        {
          id: "d-2",
          name: "指令对齐",
          code: "AL-02",
          summary: null,
          sortOrder: 2,
          createdAt: "2024-01-02T00:00:00.000Z",
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
    // 点击展开快捷下拉：一步切换，不再先进领域选择对话框。
    fireEvent.click(picker);
    expect(screen.getByRole("menu", { name: "领域快捷切换" })).toBeInTheDocument();
    expect(useField.getState().dialog).toBeNull();
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

describe("PaperNav · 批量工具栏扩展（移动 / 标状态 / 标签 / 入库作业）", () => {
  it("批量模式提供移动、标为已读、标为在读、标签与删除；点击走对应动作或对话框", () => {
    const setCheckedReadingStatus = vi.fn(async () => undefined);
    useField.setState({
      mode: "field",
      papers: [intakeItem("a", null), intakeItem("b", null)],
      batchMode: true,
      checkedPaperIds: ["a"],
      setCheckedReadingStatus,
    });
    render(<PaperNav />);

    fireEvent.click(screen.getByRole("button", { name: "移动到领域" }));
    expect(useField.getState().dialog).toBe("move-checked");
    expect(useField.getState().dialogPaperIds).toEqual(["a"]);

    fireEvent.click(screen.getByRole("button", { name: "标为已读" }));
    expect(setCheckedReadingStatus).toHaveBeenCalledWith("read");
    fireEvent.click(screen.getByRole("button", { name: "标为在读" }));
    expect(setCheckedReadingStatus).toHaveBeenCalledWith("reading");

    fireEvent.click(screen.getByRole("button", { name: "标签…" }));
    expect(useField.getState().dialog).toBe("tag-checked");

    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument();
  });

  it("无勾选时新动作与删除一样禁用", () => {
    useField.setState({
      mode: "field",
      papers: [intakeItem("a", null)],
      batchMode: true,
      checkedPaperIds: [],
    });
    render(<PaperNav />);
    expect(screen.getByRole("button", { name: "移动到领域" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "标为已读" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "标签…" })).toBeDisabled();
  });

  it("入库页批量工具栏额外提供「解析选中」「补全选中」；阅读页不提供", () => {
    const retryMineruPapers = vi.fn(async () => undefined);
    const retryFailedMetaJobs = vi.fn(async () => undefined);
    useField.setState({
      mode: "intake",
      intake: [intakeItem("a", "error")],
      batchMode: true,
      checkedPaperIds: ["a"],
      retryMineruPapers,
      retryFailedMetaJobs,
    });
    const { unmount } = render(<PaperNav />);
    fireEvent.click(screen.getByRole("button", { name: "解析选中" }));
    expect(retryMineruPapers).toHaveBeenCalledWith(["a"]);
    fireEvent.click(screen.getByRole("button", { name: "补全选中" }));
    expect(retryFailedMetaJobs).toHaveBeenCalledWith(["a"]);
    unmount();

    useField.setState({ mode: "field", papers: [intakeItem("a", null)], intake: [] });
    render(<PaperNav />);
    expect(screen.queryByRole("button", { name: "解析选中" })).toBeNull();
    expect(screen.queryByRole("button", { name: "补全选中" })).toBeNull();
  });
});

describe("PaperNav · 上次阅读一键续读", () => {
  it("显示领域内最近标记已读的论文（标题 + 日期），点击直达续读", () => {
    const selectPaper = vi.fn(async () => undefined);
    const older = { ...intakeItem("old", null), readingStatus: "read" as const, readAt: "2024-09-01T00:00:00.000Z", title: "Older Paper" };
    const newer = { ...intakeItem("new", null), readingStatus: "read" as const, readAt: "2024-10-05T00:00:00.000Z", title: "Newer Paper" };
    useField.setState({
      mode: "field",
      selectedDomainId: "d-1",
      papers: [older, newer, intakeItem("u", null)],
      selectPaper,
    });
    render(<PaperNav />);
    const lastRead = screen.getByRole("button", { name: /上次阅读/ });
    expect(lastRead.textContent).toContain("Newer Paper");
    expect(lastRead.textContent).toContain("2024.10.05");
    fireEvent.click(lastRead);
    expect(selectPaper).toHaveBeenCalledWith("new");
  });

  it("领域内没有已读论文时不显示该行", () => {
    useField.setState({ mode: "field", selectedDomainId: "d-1", papers: [intakeItem("a", null)] });
    render(<PaperNav />);
    expect(screen.queryByRole("button", { name: /上次阅读/ })).toBeNull();
  });
});

describe("PaperNav · 领域关键问题提示", () => {
  it("领域设置了关键问题时在领域头显示一句话提示", () => {
    useField.setState({
      mode: "field",
      selectedDomainId: "d-1",
      domains: [
        {
          id: "d-1",
          name: "多模态",
          code: "MM-01",
          summary: null,
          keyQuestion: "视觉与语言在哪个粒度上对齐最有效？",
          sortOrder: 1,
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    render(<PaperNav />);
    expect(screen.getByText("关键问题")).toBeInTheDocument();
    expect(screen.getByText(/视觉与语言在哪个粒度上对齐最有效/)).toBeInTheDocument();
  });

  it("未设置时不显示提示行", () => {
    useField.setState({
      mode: "field",
      selectedDomainId: "d-1",
      domains: [
        { id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
      ],
    });
    render(<PaperNav />);
    expect(screen.queryByText("关键问题")).toBeNull();
  });
});

describe("PaperNav · 领域强调色归组", () => {
  it("领域设置强调色时导航头挂上对应 CSS 变量", () => {
    useField.setState({
      mode: "field",
      selectedDomainId: "d-1",
      domains: [
        { id: "d-1", name: "多模态", code: "MM-01", summary: null, accent: "teal", sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
      ],
      papers: [intakeItem("a", null)],
    });
    render(<PaperNav />);
    expect(document.querySelector(".ef-nav-head")?.getAttribute("style")).toContain("--pf-domain-accent: var(--pf-accent-teal)");
  });

  it("未设置时不挂变量（回落默认墨色）", () => {
    useField.setState({
      mode: "field",
      selectedDomainId: "d-1",
      domains: [
        { id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
      ],
      papers: [intakeItem("a", null)],
    });
    render(<PaperNav />);
    expect(document.querySelector(".ef-nav-head")?.getAttribute("style") ?? "").not.toContain("--pf-domain-accent");
  });
});

describe("PaperNav · 恢复领域现场提示", () => {
  it("恢复了该领域上次的搜索词时显示提示行，点「清空条件」清掉搜索并撤销提示", async () => {
    const setSearch = vi.fn(async () => undefined);
    useField.setState({
      mode: "field",
      selectedDomainId: "d-1",
      search: "clip",
      restoredSearchFor: "d-1",
      setSearch,
    });
    render(<PaperNav />);
    expect(screen.getByText(/已恢复这个领域上次的搜索/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清空条件" }));
    expect(setSearch).toHaveBeenCalledWith("");
    expect(useField.getState().restoredSearchFor).toBeNull();
  });

  it("提示只对当前领域显示；其他领域不显示", () => {
    useField.setState({ mode: "field", selectedDomainId: "d-2", search: "clip", restoredSearchFor: "d-1" });
    render(<PaperNav />);
    expect(screen.queryByText(/已恢复这个领域上次的搜索/)).toBeNull();
  });
});
