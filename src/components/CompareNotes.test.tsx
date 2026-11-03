import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteKind, PaperDetail } from "../lib/types";
import { NOTE_KINDS } from "../lib/types";
import { repo } from "../lib/repo";
import { useField } from "../store";
import { CompareNotesDialog } from "./Dialogs";

function detail(id: string, title: string): PaperDetail {
  const notes = {} as Record<NoteKind, PaperDetail["notes"][NoteKind]>;
  for (const kind of NOTE_KINDS) {
    notes[kind] = {
      id: `${id}-${kind}`,
      paperId: id,
      kind,
      content: "",
      source: "manual",
      userEdited: false,
      rev: 0,
      revisedAt: null,
    };
  }
  return {
    id,
    domainId: "d-1",
    title,
    titleZh: null,
    abstract: "",
    year: 2023,
    venue: "NeurIPS",
    doi: null,
    arxivId: null,
    pdfUrl: null,
    pdfPath: null,
    codeUrl: null,
    codeOpenSource: "open",
    projectPage: null,
    readingStatus: "read",
    readAt: "2026-01-01T00:00:00.000Z",
    llmPreparedAt: null,
    notesDraftedByLlm: false,
    userNotesTouched: true,
    userMetaTouched: false,
    mineruStatus: "done",
    mineruParseId: null,
    mineruDocRef: null,
    mineruError: null,
    mineruParseIds: [],
    mineruProvider: null,
    mineruCredFingerprint: null,
    tags: [],
    labs: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    parsedMarkdown: "",
    domain: {
      id: "d-1",
      name: "多模态",
      code: "MM-01",
      summary: null,
      sortOrder: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
    },
    authors: [],
    notes,
  };
}

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
});

describe("CompareNotesDialog · 五块笔记对照表", () => {
  it("加载勾选论文：表头含五块笔记列，行内显示年份、开源与摘录（超长截断）", async () => {
    const p1 = detail("p1", "Attention Is All You Need");
    p1.notes.summary.content = "长".repeat(120);
    const p2 = detail("p2", "CLIP");
    vi.spyOn(repo, "getPaper").mockImplementation(async (id: string) => (id === "p1" ? p1 : p2));

    useField.setState({ dialog: "compare-notes", dialogPaperIds: ["p1", "p2"] });
    render(<CompareNotesDialog />);

    expect(screen.getByText("正在读取选中的论文与笔记…")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTitle("回到总结")).toBeInTheDocument();
    });
    for (const label of ["总结", "亮点", "不足", "启示", "备注"]) {
      expect(screen.getByRole("columnheader", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Attention Is All You Need" })).toBeInTheDocument();
    expect(screen.getAllByText("2023")).toHaveLength(2);
    expect(screen.getAllByText("开源").length).toBeGreaterThanOrEqual(1);
    // 120 字摘录截断为 79 字 + 省略号；可点格的 aria-label 指明回到哪篇哪块。
    expect(screen.getByTitle("回到总结").textContent).toMatch(/^长{79}…$/);
    expect(
      screen.getByRole("button", { name: "回到「Attention Is All You Need」的总结" }),
    ).toBeInTheDocument();
    // 未写的块显示占位「未写」，不是可点按钮。
    expect(screen.getAllByText("未写").length).toBeGreaterThanOrEqual(5);
  });

  it("点击笔记格：关闭对话框并回到该论文阅读页的对应笔记块", async () => {
    const p1 = detail("p1", "Attention Is All You Need");
    p1.notes.highlights.content = "多头注意力";
    vi.spyOn(repo, "getPaper").mockResolvedValue(p1);
    const selectDomain = vi.fn(async () => undefined);
    const selectPaper = vi.fn(async () => undefined);
    useField.setState({
      dialog: "compare-notes",
      dialogPaperIds: ["p1"],
      selectDomain,
      selectPaper,
    });
    render(<CompareNotesDialog />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "回到「Attention Is All You Need」的亮点" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "回到「Attention Is All You Need」的亮点" }));
    await waitFor(() => {
      expect(useField.getState().dialog).toBeNull();
    });
    expect(selectDomain).toHaveBeenCalledWith("d-1");
    expect(selectPaper).toHaveBeenCalledWith("p1");
  });

  it("全部落空提示论文不存在", async () => {
    vi.spyOn(repo, "getPaper").mockResolvedValue(null);
    useField.setState({ dialog: "compare-notes", dialogPaperIds: ["gone"] });
    render(<CompareNotesDialog />);
    await waitFor(() => {
      expect(screen.getByText("选中的论文已不存在。")).toBeInTheDocument();
    });
  });

  it("读取失败提示稍后重试，不抛错", async () => {
    vi.spyOn(repo, "getPaper").mockRejectedValue(new Error("boom"));
    useField.setState({ dialog: "compare-notes", dialogPaperIds: ["p1"] });
    render(<CompareNotesDialog />);
    await waitFor(() => {
      expect(screen.getByText("读取笔记失败，请稍后重试。")).toBeInTheDocument();
    });
  });
});
