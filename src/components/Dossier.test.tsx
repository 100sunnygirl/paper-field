import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTE_DISPLAY_ORDER, type NoteKind, type PaperDetail } from "../lib/types";
import { useField } from "../store";
import { ReadingStage } from "./Dossier";

function paper(filled: Partial<Record<NoteKind, string>>, abstract = "An abstract."): PaperDetail {
  const notes = Object.fromEntries(
    NOTE_DISPLAY_ORDER.map((kind) => [
      kind,
      { id: `n-${kind}`, paperId: "p1", kind, content: filled[kind] ?? "", source: "manual", userEdited: false },
    ]),
  ) as PaperDetail["notes"];
  return {
    id: "p1",
    domainId: "d1",
    title: "Visual Instruction Tuning",
    titleZh: null,
    abstract,
    year: 2023,
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
    authors: [],
    notes,
    domain: { id: "d1", name: "多模态", code: "MM-01", summary: null, sortOrder: 0, createdAt: "2024-01-01T00:00:00.000Z" },
    parsedMarkdown: "",
  } as unknown as PaperDetail;
}

function renderStage() {
  return render(
    <ReadingStage
      focus={false}
      onToggleFocus={() => {}}
      listOpen={false}
      onToggleList={() => {}}
      contextOpen={false}
      onToggleContext={() => {}}
    />,
  );
}

beforeAll(() => {
  // jsdom 没有 IntersectionObserver / matchMedia；目录高亮与平滑滚动不在本测试范围。
  globalThis.IntersectionObserver ??= class {
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
  window.matchMedia ??= (() => ({ matches: true })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
});

describe("ReadingStage · 笔记与论文信息的入口不重复", () => {
  it("工具条不再有「写笔记」；笔记只在各自的块里就地编辑", () => {
    useField.setState({ mode: "field", paper: paper({ summary: "已写的总结" }) });
    renderStage();
    expect(screen.queryByRole("button", { name: "写笔记" })).toBeNull();
    // 有内容的块显示「编辑」，空块本身是「写…」入口，不再同时挂「编辑」。
    expect(screen.getByRole("button", { name: "编辑总结" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑亮点" })).toBeNull();
    expect(screen.getByRole("button", { name: "写亮点" })).toBeInTheDocument();
  });

  it("Cmd or Ctrl S on the note saves it, and Escape does not cancel it", async () => {
    const saveNote = vi.fn(async () => undefined);
    const setNoteDraft = vi.fn();
    useField.setState({
      mode: "field",
      paper: paper({}),
      drafts: { p1: { summary: "草稿" } },
      saveNote,
      setNoteDraft,
    });
    renderStage();
    const box = screen.getByRole("textbox", { name: "总结内容" });
    expect(fireEvent.keyDown(box, { key: "s", ctrlKey: true })).toBe(false);
    await waitFor(() => expect(screen.getByRole("button", { name: "保存笔记" })).toBeEnabled());
    expect(saveNote).toHaveBeenCalledTimes(1);
    expect(fireEvent.keyDown(box, { key: "s", metaKey: true })).toBe(false);
    await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2));
    expect(saveNote).toHaveBeenNthCalledWith(1, "p1", "summary", "草稿");
    expect(saveNote).toHaveBeenNthCalledWith(2, "p1", "summary", "草稿");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(setNoteDraft).not.toHaveBeenCalled();
  });

  it("shows 保存全部 only while a draft is open", () => {
    const saveOpenDrafts = vi.fn(async () => undefined);
    useField.setState({ mode: "field", paper: paper({}), saveOpenDrafts });
    const view = renderStage();
    expect(screen.queryByRole("button", { name: "保存全部" })).toBeNull();
    useField.setState({ drafts: { p1: { summary: "" } } });
    view.rerender(
      <ReadingStage
        focus={false}
        onToggleFocus={() => {}}
        listOpen={false}
        onToggleList={() => {}}
        contextOpen={false}
        onToggleContext={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "保存全部" }));
    expect(saveOpenDrafts).toHaveBeenCalledWith("p1");
  });

  it("点击空块的「写…」在原位打开该块的编辑框", () => {
    const setNoteDraft = vi.fn();
    useField.setState({ mode: "field", paper: paper({}), setNoteDraft });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "写不足" }));
    expect(setNoteDraft).toHaveBeenCalledWith("p1", "weaknesses", "");
  });

  it("「更多操作」里的编辑论文信息写明改的是题录，不是笔记", () => {
    useField.setState({ mode: "field", paper: paper({}) });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("button", { name: /编辑论文信息\s*标题、作者、摘要、PDF 与链接/ })).toBeInTheDocument();
  });

  it("文件名徽章紧挨标题，但不写进标题文本", () => {
    const row = paper({});
    row.title = "smoke";
    row.fieldSources = { title: "file" };
    useField.setState({ mode: "field", paper: row });
    renderStage();
    const title = document.getElementById("paper-title");
    expect(title?.textContent).toBe("smoke");
    expect(title?.contains(screen.getByText("文件名"))).toBe(false);
    expect(screen.getByText("文件名")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "认领标题" })).toBeInTheDocument();
  });

  it("笔记确认的接受、跳过和接受全部各调用一次 settleNoteReview", () => {
    const settleNoteReview = vi.fn(async () => undefined);
    useField.setState({
      mode: "field",
      paper: paper({ summary: "旧" }),
      noteReview: {
        paperId: "p1",
        proposals: [
          { kind: "summary", rev: 2, before: "旧", after: "新" },
          { kind: "highlights", rev: 0, before: "", after: "亮" },
        ],
      },
      settleNoteReview,
    });
    renderStage();
    const review = screen.getByRole("region", { name: "笔记确认" });
    expect(review).toHaveTextContent("之前");
    expect(review).toHaveTextContent("之后");
    expect(review).toHaveTextContent("新");
    expect(review).toHaveTextContent("亮");
    const named = (label: string) => screen.getAllByRole("button", { name: (name) => name === label });
    fireEvent.click(named("接受")[0]);
    fireEvent.click(named("跳过")[1]);
    fireEvent.click(screen.getByRole("button", { name: "接受全部" }));
    expect(settleNoteReview).toHaveBeenNthCalledWith(1, { accept: ["summary"] });
    expect(settleNoteReview).toHaveBeenNthCalledWith(2, { skip: ["highlights"] });
    expect(settleNoteReview).toHaveBeenNthCalledWith(3, { accept: ["summary", "highlights"] });
    expect(settleNoteReview).toHaveBeenCalledTimes(3);
  });

  it("摘要为空时直接给出编辑论文信息的入口", () => {
    useField.setState({ mode: "field", paper: paper({}, "") });
    renderStage();
    expect(screen.getByText(/摘要属于论文信息，不是笔记/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "编辑论文信息" })[0]);
    expect(useField.getState().dialog).toBe("edit-paper");
  });
});
