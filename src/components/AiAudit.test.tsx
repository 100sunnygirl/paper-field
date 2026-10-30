import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordAiWrite, snapshotMeta, snapshotNotes } from "../lib/aiAudit";
import { NOTE_DISPLAY_ORDER, type NoteKind, type PaperDetail } from "../lib/types";
import { useField } from "../store";
import { AiDiffDialog, MetaPreviewDialog, NotePreviewDialog } from "./AiAudit";

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

describe("MetaPreviewDialog · 干跑预览确认", () => {
  beforeEach(() => {
    localStorage.removeItem("paper-field.ai-preview-first");
  });

  it("列出将写入的字段与来源；写入调用 applyMetaPreview，不写入走 dismissMetaPreview", async () => {
    const applyMetaPreview = vi.fn(async () => undefined);
    const dismissMetaPreview = vi.fn();
    useField.setState({
      dialog: "ai-preview",
      dialogPaperId: "p1",
      metaPreview: {
        paperId: "p1",
        paperTitle: "Real Title",
        at: Date.now(),
        startedRev: 0,
        overwrite: false,
        apiMeta: null,
        llmMeta: null,
        before: snapshotMeta(detail()),
        changes: [
          { field: "title", from: "文件名标题", to: "Real Title", incoming: "api", provider: "crossref" },
          { field: "titleZh", from: "", to: "中文标题", incoming: "llm", provider: null },
        ],
      },
      applyMetaPreview,
      dismissMetaPreview,
    });
    render(<MetaPreviewDialog />);
    expect(screen.getByText(/还没有写库/)).toBeInTheDocument();
    expect(screen.getByText("英文标题")).toBeInTheDocument();
    expect(screen.getByText("来源：数据库 · Crossref")).toBeInTheDocument();
    expect(screen.getByText("来源：模型")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "写入 2 项" }));
    await waitFor(() => expect(applyMetaPreview).toHaveBeenCalledTimes(1));
    // 重新打开改为放弃
    useField.setState({ dialog: "ai-preview", dialogPaperId: "p1" });
    fireEvent.click(screen.getByRole("button", { name: "不写入" }));
    expect(dismissMetaPreview).toHaveBeenCalledTimes(1);
  });

  it("没有可写字段时写入按钮禁用并说明", () => {
    useField.setState({
      dialog: "ai-preview",
      dialogPaperId: "p1",
      metaPreview: {
        paperId: "p1",
        paperTitle: "Real Title",
        at: Date.now(),
        startedRev: 0,
        overwrite: false,
        apiMeta: null,
        llmMeta: null,
        before: snapshotMeta(detail()),
        changes: [],
      },
    });
    render(<MetaPreviewDialog />);
    expect(screen.getByText(/没有需要写入的字段/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "写入 0 项" })).toBeDisabled();
  });
});

describe("NotePreviewDialog · 草稿逐块采纳", () => {
  function previewFixture() {
    return {
      paperId: "p1",
      paperTitle: "Real Title",
      at: Date.now(),
      revs: {},
      kinds: ["summary", "highlights", "weaknesses", "implications", "remarks"] as NoteKind[],
      drafted: {
        remarks: "",
        summary: "AI 总结",
        highlights: "AI 亮点",
        weaknesses: "",
        implications: "",
      },
      before: snapshotNotes(detail()),
      changes: [
        { kind: "summary" as NoteKind, from: "", to: "AI 总结" },
        { kind: "highlights" as NoteKind, from: "", to: "AI 亮点" },
      ],
    };
  }

  it("逐块列出草稿 diff；默认只勾空块；采纳传勾选名单", async () => {
    const applyNotePreview = vi.fn(async (_kinds: NoteKind[]) => undefined);
    useField.setState({ dialog: "ai-note-preview", dialogPaperId: "p1", notePreview: previewFixture(), applyNotePreview });
    render(<NotePreviewDialog />);
    expect(screen.getByText(/逐块勾选要采纳的草稿/)).toBeInTheDocument();
    // 空块默认勾选（总结/亮点是空块且草稿非空）；弱检查：采纳 2 块。
    const button = screen.getByRole("button", { name: "采纳 2 块" });
    fireEvent.click(button);
    await waitFor(() => expect(applyNotePreview).toHaveBeenCalledTimes(1));
    const kinds = vi.mocked(applyNotePreview).mock.calls[0]![0];
    expect([...kinds].sort()).toEqual(["highlights", "summary"]);
  });

  it("全部放弃走 dismissNotePreview", () => {
    const dismissNotePreview = vi.fn();
    useField.setState({ dialog: "ai-note-preview", dialogPaperId: "p1", notePreview: previewFixture(), dismissNotePreview });
    render(<NotePreviewDialog />);
    fireEvent.click(screen.getByRole("button", { name: "全部放弃" }));
    expect(dismissNotePreview).toHaveBeenCalledTimes(1);
  });
});
