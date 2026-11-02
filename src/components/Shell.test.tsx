import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useField } from "../store";
import { Dock, StatusStrip } from "./Shell";
import { beginBatchItem, endBatchItem, queueBatch, resetActivity, startBatch } from "../lib/activity";
import type { LlmJob } from "../lib/types";

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

  it("shows the draft count only when a note draft is open", () => {
    const { rerender } = render(<StatusStrip />);
    expect(screen.queryByText(/笔记草稿/)).toBeNull();
    useField.setState({ drafts: { p1: { summary: "" }, p2: { highlights: "x" } } });
    rerender(<StatusStrip />);
    expect(screen.getByText(/笔记草稿/)).toHaveTextContent("笔记草稿 2");
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
