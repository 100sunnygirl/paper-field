import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTE_DISPLAY_ORDER, type NoteKind, type PaperDetail } from "../lib/types";
import { repo } from "../lib/repo";
import { useField } from "../store";
import { ReadingStage } from "./Dossier";

vi.mock("../lib/repo", () => ({
  repo: {
    updateNote: vi.fn(async () => undefined),
    stats: vi.fn(async () => ({ read: 0, total: 1, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    getPaper: vi.fn(async () => null),
  },
}));

function paper(filled: Partial<Record<NoteKind, string>> = {}): PaperDetail {
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
    abstract: "An abstract.",
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
  globalThis.IntersectionObserver ??= class {
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
  window.matchMedia ??= (() => ({ matches: true })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
  vi.mocked(repo.updateNote).mockClear();
  vi.mocked(repo.getPaper).mockImplementation(async () => paper() as never);
});

describe("ReadingStage · 笔记保存快捷键与 Esc 保留草稿", () => {
  it("编辑框内 ⌘S 保存当前块：落库、清草稿、给出保存提示", async () => {
    const detail = paper();
    useField.setState({ mode: "field", paper: detail, selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "写总结" }));
    const textarea = screen.getByLabelText("总结内容");
    fireEvent.change(textarea, { target: { value: "用一句话总结这篇论文。" } });
    fireEvent.keyDown(textarea, { key: "s", metaKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(repo.updateNote).toHaveBeenCalledWith("p1", "summary", "用一句话总结这篇论文。", "manual", true));
    await waitFor(() => expect(useField.getState().drafts.p1).toBeUndefined());
    expect(useField.getState().flash?.tone).toBe("ok");
  });

  it("Esc 只收起编辑器：草稿保留、出现「继续编辑」入口与提示", () => {
    const detail = paper();
    useField.setState({ mode: "field", paper: detail, selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "写总结" }));
    const textarea = screen.getByLabelText("总结内容");
    fireEvent.change(textarea, { target: { value: "写了一半" } });
    fireEvent.keyDown(textarea, { key: "Escape", bubbles: true, cancelable: true });
    // 编辑框收起，但草稿仍在 store
    expect(screen.queryByLabelText("总结内容")).toBeNull();
    expect(useField.getState().drafts.p1?.summary).toBe("写了一半");
    expect(useField.getState().flash?.text).toContain("草稿已保留");
    // 收起后给出继续编辑入口与常驻草稿提示
    fireEvent.click(screen.getByRole("button", { name: "继续编辑总结" }));
    expect(screen.getByLabelText("总结内容")).toBeInTheDocument();
    expect(screen.getByLabelText("总结内容")).toHaveValue("写了一半");
  });

  it("⌘Enter 保存当前块并自动打开下一块空笔记（亮点）继续写", async () => {
    const detail = paper({ summary: "总结已写" });
    useField.setState({ mode: "field", paper: detail, selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "编辑总结" }));
    const textarea = screen.getByLabelText("总结内容");
    fireEvent.change(textarea, { target: { value: "改写总结。" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(repo.updateNote).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByLabelText("亮点内容")).toBeInTheDocument());
  });

  it("「保存本篇全部」逐块保存全部草稿并汇总提示", async () => {
    const detail = paper();
    useField.setState({ mode: "field", paper: detail, selectedPaperId: "p1" });
    useField.getState().setNoteDraft("p1", "summary", "草稿一");
    useField.getState().setNoteDraft("p1", "weaknesses", "草稿二");
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: /保存本篇全部（2 处草稿）/ }));
    await waitFor(() => expect(repo.updateNote).toHaveBeenCalledTimes(2));
    expect(repo.updateNote).toHaveBeenCalledWith("p1", "summary", "草稿一", "manual", true);
    expect(repo.updateNote).toHaveBeenCalledWith("p1", "weaknesses", "草稿二", "manual", true);
    await waitFor(() => expect(useField.getState().drafts.p1).toBeUndefined());
    expect(useField.getState().flash?.text).toContain("已保存本篇全部笔记（2 块）");
  });

  it("没有草稿时不显示「保存本篇全部」入口", () => {
    useField.setState({ mode: "field", paper: paper({ summary: "已写" }), selectedPaperId: "p1" });
    renderStage();
    expect(screen.queryByRole("button", { name: /保存本篇全部/ })).toBeNull();
  });
});

describe("store · saveAllNoteDrafts", () => {
  it("单块失败时：已保存的落库、失败的保留草稿并汇总原因", async () => {
    const detail = paper();
    useField.setState({ mode: "field", paper: detail, selectedPaperId: "p1" });
    useField.getState().setNoteDraft("p1", "summary", "好的草稿");
    useField.getState().setNoteDraft("p1", "highlights", "坏的草稿");
    vi.mocked(repo.updateNote).mockImplementation(async (_paperId, kind) => {
      if (kind === "highlights") throw new Error("写入失败");
    });
    await useField.getState().saveAllNoteDrafts("p1");
    expect(useField.getState().drafts.p1?.summary).toBeUndefined();
    expect(useField.getState().drafts.p1?.highlights).toBe("坏的草稿");
    expect(useField.getState().flash?.tone).toBe("warn");
    expect(useField.getState().flash?.text).toContain("1 块保存失败（亮点）");
  });

  it("没有草稿时给出提示且不写库", async () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    await useField.getState().saveAllNoteDrafts("p1");
    expect(repo.updateNote).not.toHaveBeenCalled();
    expect(useField.getState().flash?.text).toContain("没有未保存的笔记草稿");
  });
});
