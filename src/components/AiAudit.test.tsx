import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordAiWrite, snapshotMeta, snapshotNotes } from "../lib/aiAudit";
import { NOTE_DISPLAY_ORDER, type PaperDetail } from "../lib/types";
import { useField } from "../store";
import { AiDiffDialog } from "./AiAudit";

function detail(): PaperDetail {
  return {
    id: "p1",
    domainId: "d1",
    title: "Real Title",
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
    authors: [],
    notes: Object.fromEntries(
      NOTE_DISPLAY_ORDER.map((kind) => [
        kind,
        { id: `n-${kind}`, paperId: "p1", kind, content: "", source: "manual" as const, userEdited: false, revisedAt: null },
      ]),
    ) as PaperDetail["notes"],
    domain: { id: "d1", name: "多模态", code: "MM-01", summary: null, sortOrder: 0, createdAt: "2024-01-01T00:00:00.000Z" },
    parsedMarkdown: "",
  };
}

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
});

describe("AiDiffDialog · AI 写入的变更查看与撤销", () => {
  it("无记录时给诚实的会话内说明", () => {
    useField.setState({ dialog: "ai-diff", dialogPaperId: "p1" });
    render(<AiDiffDialog />);
    expect(screen.getByText(/还没有这篇论文的 AI 写入记录/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "撤销本次 AI 写入" })).toBeNull();
  });

  it("列出字段与笔记块的旧值→新值；撤销调用 undoAiWrite 并关闭", async () => {
    const base = detail();
    const before = snapshotMeta({ ...base, title: "文件名标题" });
    const after = snapshotMeta(base);
    recordAiWrite({
      paperId: "p1",
      paperTitle: "Real Title",
      kind: "meta",
      meta: {
        before,
        after,
        changes: [{ field: "title", from: "文件名标题", to: "Real Title" }],
      },
    });
    const notesBefore = snapshotNotes(base);
    const notesAfter = snapshotNotes({
      ...base,
      notes: { ...base.notes, summary: { ...base.notes.summary, content: "AI 总结" } },
    });
    recordAiWrite({
      paperId: "p1",
      paperTitle: "Real Title",
      kind: "notes",
      notes: {
        before: notesBefore,
        after: notesAfter,
        changes: [{ kind: "summary", from: "", to: "AI 总结" }],
      },
    });
    const undoAiWrite = vi.fn(async () => undefined);
    useField.setState({ dialog: "ai-diff", dialogPaperId: "p1", undoAiWrite });
    render(<AiDiffDialog />);
    // 最新一条是 notes 记录：两段都展示（字段区来自 meta 记录的行不会出现，只显示最新记录的内容）。
    expect(screen.getByText("AI 总结")).toBeInTheDocument();
    expect(screen.getByText("（空白）")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "撤销本次 AI 写入" }));
    await waitFor(() => expect(undoAiWrite).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useField.getState().dialog).toBeNull());
  });

  it("版本列表展示 AI 与手动版本，恢复调用 restoreNoteVersion", async () => {
    const { pushNoteVersion } = await import("../lib/aiAudit");
    pushNoteVersion("p1", "summary", "user", "我的第一版");
    pushNoteVersion("p1", "summary", "ai", "AI 草稿");
    const restoreNoteVersion = vi.fn(async () => undefined);
    useField.setState({ dialog: "ai-diff", dialogPaperId: "p1", restoreNoteVersion });
    render(<AiDiffDialog />);
    expect(screen.getByText("AI 写入")).toBeInTheDocument();
    expect(screen.getByText("手动保存")).toBeInTheDocument();
    expect(screen.getByText("我的第一版")).toBeInTheDocument();
    const restoreButtons = screen.getAllByRole("button", { name: "恢复" });
    fireEvent.click(restoreButtons[0]);
    await waitFor(() => expect(restoreNoteVersion).toHaveBeenCalledWith("p1", "summary", "AI 草稿"));
    expect(screen.getByText(/版本只保存在本次会话中/)).toBeInTheDocument();
  });
});
