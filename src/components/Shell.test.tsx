import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useField } from "../store";
import { Dock, StatusStrip } from "./Shell";
import { beginBatchItem, endBatchItem, queueBatch, resetActivity, startBatch } from "../lib/activity";
import { repo } from "../lib/repo";
import type { LlmJob, PaperDetail } from "../lib/types";

vi.mock("../lib/repo", () => ({
  repo: {
    searchAll: vi.fn(async () => []),
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    getPaper: vi.fn(async () => null),
    updateNote: vi.fn(async () => undefined),
  },
}));

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
});

describe("Dock · 顶栏只放品牌", () => {
  it.each(["field", "archive", "intake", "system"] as const)("%s 模式不在顶栏放搜索框与添加按钮", (mode) => {
    useField.setState({ mode });
    render(<Dock />);
    expect(screen.getByText("PAPER FIELD")).toBeInTheDocument();
    expect(screen.queryByLabelText("搜索论文")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("StatusStrip · 作业入口", () => {
  function running(id: string, status: LlmJob["status"] = "running"): LlmJob {
    return {
      id,
      paperId: `paper-${id}`,
      type: "mineruParse",
      status,
      prompt: null,
      resultJson: null,
      error: null,
      createdAt: "2026-10-08T10:00:00.000Z",
      startedAt: status === "running" ? "2026-10-08T10:00:00.000Z" : null,
      finishedAt: null,
    };
  }

  beforeEach(() => {
    resetActivity();
  });

  it("空闲时显示「队列空闲」，点击展开作业面板（aria-expanded 同步）", () => {
    render(<StatusStrip />);
    const toggle = screen.getByRole("button", { name: /队列空闲/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(useField.getState().jobsOpen).toBe(true);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(useField.getState().jobsOpen).toBe(false);
  });

  it("运行中显示作业数与本批进度（批次排队论文计入等待）", () => {
    const batchId = queueBatch("mineru", ["paper-x", "paper-a", "p3"]);
    startBatch(batchId);
    beginBatchItem(batchId, "paper-x");
    endBatchItem(batchId, "paper-x", "ok");
    beginBatchItem(batchId, "paper-a");
    useField.setState({ jobs: [running("a")] });
    render(<StatusStrip />);
    const toggle = screen.getByRole("button", { name: /作业运行中 1/ });
    expect(toggle).toHaveTextContent("MinerU 解析 1/3");
    expect(toggle.closest(".ef-status-jobs")).toHaveClass("busy");
  });

  it("只有排队、没有运行时显示「作业等待」（含批次里尚未开始的论文）", () => {
    const batchId = queueBatch("mineru", ["p1", "p2"]);
    expect(batchId).toBeGreaterThan(0);
    render(<StatusStrip />);
    expect(screen.getByRole("button", { name: /作业等待 2/ })).toBeInTheDocument();
  });
});

describe("StatusStrip · 未保存草稿集中入口", () => {
  function draftPaper(id: string, title: string): PaperDetail {
    return {
      id,
      title,
      titleZh: null,
      domainId: "d1",
      domain: { id: "d1", name: "多模态", code: "MM-01", summary: null, sortOrder: 0, createdAt: "2024-01-01T00:00:00.000Z" },
    } as unknown as PaperDetail;
  }

  beforeEach(() => {
    vi.mocked(repo.updateNote).mockClear();
    vi.mocked(repo.getPaper).mockReset();
    vi.mocked(repo.getPaper).mockImplementation(async () => null);
  });

  it("没有草稿时不渲染入口；有草稿时常驻显示「N 处草稿未保存」", () => {
    const { rerender } = render(<StatusStrip />);
    expect(screen.queryByRole("button", { name: /处草稿未保存/ })).toBeNull();
    useField.getState().setNoteDraft("p1", "summary", "写了一半的总结");
    useField.getState().setNoteDraft("p1", "weaknesses", "另一起草稿");
    useField.getState().setNoteDraft("p2", "highlights", "别篇论文的草稿");
    rerender(<StatusStrip />);
    expect(screen.getByRole("button", { name: /3 处草稿未保存/ })).toBeInTheDocument();
  });

  it("点击展开跨论文清单：论文×笔记块、草稿预览与逐项动作", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) =>
      id === "p1" ? draftPaper("p1", "视觉指令微调") : draftPaper("p2", "CLIP 论文"),
    );
    useField.setState({ mode: "field" });
    useField
      .getState()
      .setNoteDraft(
        "p1",
        "summary",
        "这是一段写得很长的总结草稿，超过四十个字符用来验证清单里的预览会被截断并追加省略号。",
      );
    useField.getState().setNoteDraft("p2", "highlights", "对比学习预训练");
    render(<StatusStrip />);
    fireEvent.click(screen.getByRole("button", { name: /2 处草稿未保存/ }));
    const panel = await screen.findByRole("dialog", { name: "未保存草稿清单" });
    expect(within(panel).getByRole("button", { name: "视觉指令微调" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "CLIP 论文" })).toBeInTheDocument();
    // 预览截断到 40 字符并加省略号
    expect(within(panel).getByText(/…$/)).toBeInTheDocument();
    expect(within(panel).getByText("对比学习预训练")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "保存总结草稿" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "放弃亮点草稿" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "全部保存" })).toBeInTheDocument();
  });

  it("逐项保存走 saveNote 落库；逐项放弃只清草稿不写库", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => draftPaper(id, "视觉指令微调"));
    useField.setState({ mode: "field" });
    useField.getState().setNoteDraft("p1", "summary", "要保存的草稿");
    useField.getState().setNoteDraft("p1", "highlights", "要放弃的草稿");
    render(<StatusStrip />);
    fireEvent.click(screen.getByRole("button", { name: /2 处草稿未保存/ }));
    fireEvent.click(await screen.findByRole("button", { name: "保存总结草稿" }));
    await waitFor(() => expect(repo.updateNote).toHaveBeenCalledWith("p1", "summary", "要保存的草稿", "manual", true));
    await waitFor(() => expect(useField.getState().drafts.p1?.summary).toBeUndefined());
    fireEvent.click(screen.getByRole("button", { name: "放弃亮点草稿" }));
    expect(useField.getState().drafts.p1).toBeUndefined();
    expect(repo.updateNote).toHaveBeenCalledTimes(1);
  });

  it("「保存本篇」与「全部保存」分别按篇、跨篇落库", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => draftPaper(id, `论文 ${id}`));
    useField.setState({ mode: "field" });
    useField.getState().setNoteDraft("p1", "summary", "草稿一");
    useField.getState().setNoteDraft("p2", "summary", "草稿二");
    render(<StatusStrip />);
    fireEvent.click(screen.getByRole("button", { name: /2 处草稿未保存/ }));
    // 两篇论文各有「保存本篇」：点第一篇（p1）的
    const saveGroupButtons = await screen.findAllByRole("button", { name: "保存本篇" });
    fireEvent.click(saveGroupButtons[0]);
    await waitFor(() => expect(repo.updateNote).toHaveBeenCalledWith("p1", "summary", "草稿一", "manual", true));
    await waitFor(() => expect(useField.getState().drafts.p1).toBeUndefined());
    expect(useField.getState().drafts.p2?.summary).toBe("草稿二");
    fireEvent.click(screen.getByRole("button", { name: "全部保存" }));
    await waitFor(() => expect(repo.updateNote).toHaveBeenCalledWith("p2", "summary", "草稿二", "manual", true));
    await waitFor(() => expect(useField.getState().drafts.p2).toBeUndefined());
    expect(useField.getState().flash?.text).toContain("已保存全部未保存草稿（1 块，1 篇论文）");
  });

  it("点击论文标题直达：切到该论文所在领域并选中", async () => {
    const selectDomain = vi.fn(async () => undefined);
    const selectPaper = vi.fn(async () => undefined);
    vi.mocked(repo.getPaper).mockImplementation(async () => draftPaper("p9", "目标论文"));
    useField.setState({ mode: "field", selectDomain, selectPaper });
    useField.getState().setNoteDraft("p9", "summary", "草稿");
    render(<StatusStrip />);
    fireEvent.click(screen.getByRole("button", { name: /1 处草稿未保存/ }));
    fireEvent.click(await screen.findByRole("button", { name: "目标论文" }));
    await waitFor(() => expect(selectDomain).toHaveBeenCalledWith("d1"));
    await waitFor(() => expect(selectPaper).toHaveBeenCalledWith("p9"));
  });

  it("标已读脉冲时状态条已读计数挂上跳动类", () => {
    useField.setState({ readPulse: 1 });
    render(<StatusStrip />);
    expect(document.querySelector(".ef-status > span > b")).toHaveClass("is-read-pulse");
  });
});
