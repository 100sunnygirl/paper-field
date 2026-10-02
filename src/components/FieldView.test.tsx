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
