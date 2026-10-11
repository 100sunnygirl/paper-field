import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperListItem } from "../lib/types";
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
