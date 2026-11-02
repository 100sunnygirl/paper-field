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
  localStorage.removeItem("paper-field.note-layout");
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

describe("ReadingStage · 笔记失焦自动落库", () => {
  it("编辑框失焦（点出块外）自动保存：落库、清草稿", async () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "写总结" }));
    const textarea = screen.getByLabelText("总结内容");
    fireEvent.change(textarea, { target: { value: "写完直接点出去。" } });
    fireEvent.blur(textarea);
    await waitFor(() => expect(repo.updateNote).toHaveBeenCalledWith("p1", "summary", "写完直接点出去。", "manual", true));
    await waitFor(() => expect(useField.getState().drafts.p1).toBeUndefined());
    expect(useField.getState().flash?.tone).toBe("ok");
  });

  it("一个字没改的草稿失焦：安静收起，不写库、不弹提示", async () => {
    const detail = paper({ summary: "已有内容" });
    useField.setState({ mode: "field", paper: detail, selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "编辑总结" }));
    const textarea = screen.getByLabelText("总结内容");
    expect(textarea).toHaveValue("已有内容");
    fireEvent.blur(textarea);
    await waitFor(() => expect(useField.getState().drafts.p1).toBeUndefined());
    expect(repo.updateNote).not.toHaveBeenCalled();
    expect(useField.getState().flash).toBeNull();
  });

  it("「放弃修改」不触发自动保存：草稿被丢弃、不写库", () => {
    const detail = paper({ summary: "原来的内容" });
    useField.setState({ mode: "field", paper: detail, selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "编辑总结" }));
    fireEvent.change(screen.getByLabelText("总结内容"), { target: { value: "试了一版不要了" } });
    // 按钮先按住焦点（mousedown preventDefault）再点击：绕开失焦自动保存
    const button = screen.getByRole("button", { name: "放弃修改" });
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    expect(useField.getState().drafts.p1).toBeUndefined();
    expect(repo.updateNote).not.toHaveBeenCalled();
    expect(screen.getByText("原来的内容")).toBeInTheDocument();
  });

  it("自动保存失败：草稿保留，失败提示可见", async () => {
    vi.mocked(repo.updateNote).mockRejectedValueOnce(new Error("写入失败"));
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "写总结" }));
    const textarea = screen.getByLabelText("总结内容");
    fireEvent.change(textarea, { target: { value: "会保存失败的内容" } });
    fireEvent.blur(textarea);
    await waitFor(() => expect(useField.getState().flash?.tone).toBe("error"));
    expect(useField.getState().drafts.p1?.summary).toBe("会保存失败的内容");
    expect(await screen.findByText("保存失败，输入已保留，可重试。")).toBeInTheDocument();
  });
});

describe("ReadingStage · 笔记块折叠与显示顺序（本机记忆）", () => {
  function noteHeadingTexts(): string[] {
    return Array.from(document.querySelectorAll(".ef-note-head h3")).map((el) => el.textContent ?? "");
  }

  it("默认五块按 总结 → 亮点 → 不足 → 启示 → 备注 排列，全部展开", () => {
    useField.setState({ mode: "field", paper: paper({ summary: "内容" }), selectedPaperId: "p1" });
    renderStage();
    expect(noteHeadingTexts()).toEqual(["总结", "亮点", "不足", "启示", "备注"]);
    expect(document.querySelector("#note-summary .ef-note-text")).toBeTruthy();
  });

  it("点折叠开关：正文收起留字数提示，偏好写进本机 localStorage", () => {
    useField.setState({ mode: "field", paper: paper({ summary: "六个字的总结" }), selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "折叠总结" }));
    expect(document.querySelector("#note-summary .ef-note-text")).toBeNull();
    expect(document.querySelector("#note-summary .ef-note-collapsed-hint")?.textContent).toContain("字 · 已折叠");
    const saved = JSON.parse(localStorage.getItem("paper-field.note-layout")!);
    expect(saved.collapsed.summary).toBe(true);
    // 再点展开恢复
    fireEvent.click(screen.getByRole("button", { name: "展开总结" }));
    expect(document.querySelector("#note-summary .ef-note-text")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("paper-field.note-layout")!).collapsed.summary).toBe(false);
  });

  it("上移 / 下移调整显示顺序：正文、序号与本页目录同步，本机记住", () => {
    useField.setState({ mode: "field", paper: paper({ summary: "内容" }), selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "上移亮点" }));
    expect(noteHeadingTexts()).toEqual(["亮点", "总结", "不足", "启示", "备注"]);
    // 序号跟随新位置：亮点变 01
    expect(document.querySelector("#note-highlights .ef-note-number")?.textContent).toBe("01");
    // 本页目录同步新顺序
    const toc = document.querySelector('.ef-toc a[href="#note-highlights"]')!;
    expect(toc.querySelector(".mono")?.textContent).toBe("01");
    expect(JSON.parse(localStorage.getItem("paper-field.note-layout")!).order[0]).toBe("highlights");
    // 首块的上移禁用
    expect(screen.getByRole("button", { name: "上移亮点" })).toBeDisabled();
  });

  it("重启（重新挂载）后按本机偏好恢复顺序与折叠", () => {
    localStorage.setItem(
      "paper-field.note-layout",
      JSON.stringify({ order: ["remarks", "summary", "highlights", "weaknesses", "implications"], collapsed: { remarks: true } }),
    );
    useField.setState({ mode: "field", paper: paper({ remarks: "备注内容", summary: "总结内容" }), selectedPaperId: "p1" });
    renderStage();
    expect(noteHeadingTexts()).toEqual(["备注", "总结", "亮点", "不足", "启示"]);
    expect(document.querySelector("#note-remarks .ef-note-text")).toBeNull();
    expect(document.querySelector("#note-remarks .ef-note-collapsed-hint")).toBeTruthy();
  });

  it("编辑中不显示折叠开关", () => {
    useField.setState({ mode: "field", paper: paper({ summary: "内容" }), selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "编辑总结" }));
    expect(screen.queryByRole("button", { name: "折叠总结" })).toBeNull();
    expect(screen.getByLabelText("总结内容")).toBeInTheDocument();
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
