import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTE_DISPLAY_ORDER, type NoteKind, type PaperDetail } from "../lib/types";
import { useField } from "../store";
import { ReadingStage } from "./Dossier";

const PARSED = "# 引言\n\n引言正文。\n\n## 方法\n\n方法正文第一段。\n";

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
    titleZh: "视觉指令微调",
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
    parsedMarkdown: PARSED,
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

/** 把文档选区桩到全文容器内指定的文本节点上。 */
function stubSelectionInsideStage(text: string, collapsed = false): { restore: () => void } {
  const original = document.getSelection.bind(document);
  const paragraphs = Array.from(document.querySelectorAll(".ef-fulltext .ef-md p"));
  const target = paragraphs[paragraphs.length - 1];
  expect(target).toBeTruthy();
  const range = {
    commonAncestorContainer: target.firstChild,
    getBoundingClientRect: () => ({ top: 120, left: 200, width: 60, height: 12 }) as DOMRect,
  };
  const selection = {
    isCollapsed: collapsed,
    rangeCount: collapsed ? 0 : 1,
    getRangeAt: () => range,
    toString: () => (collapsed ? "" : text),
  };
  vi.spyOn(document, "getSelection").mockReturnValue(selection as unknown as Selection);
  return {
    restore: () => {
      (document.getSelection as unknown as { mockRestore: () => void }).mockRestore?.();
      void original;
    },
  };
}

function fireSelectionChange() {
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
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
});

describe("ReadingStage · 从解析全文摘录到笔记", () => {
  it("选中全文段落后浮出「摘到笔记」条，一键摘到亮点并附小节锚点", () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    const stub = stubSelectionInsideStage("方法正文第一段。");
    fireSelectionChange();
    expect(screen.getByRole("toolbar", { name: "摘录到笔记" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "摘到亮点" }));
    expect(useField.getState().drafts.p1?.highlights).toBe(
      "> 原文（[§1.1 方法](#ft-sec-1)）：方法正文第一段。",
    );
    expect(useField.getState().flash?.tone).toBe("ok");
    expect(useField.getState().flash?.text).toContain("已摘录到「亮点」");
    // 摘录后浮条收起
    expect(screen.queryByRole("toolbar", { name: "摘录到笔记" })).toBeNull();
    stub.restore();
  });

  it("摘录追加而非覆盖：块里已有的内容保留，引用另起一段", () => {
    useField.setState({ mode: "field", paper: paper({ highlights: "已有亮点" }), selectedPaperId: "p1" });
    renderStage();
    const stub = stubSelectionInsideStage("方法正文第一段。");
    fireSelectionChange();
    fireEvent.click(screen.getByRole("button", { name: "摘到亮点" }));
    expect(useField.getState().drafts.p1?.highlights).toBe(
      "已有亮点\n\n> 原文（[§1.1 方法](#ft-sec-1)）：方法正文第一段。",
    );
    stub.restore();
  });

  it("「复制引用」复制「论文+小节」引用", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    const stub = stubSelectionInsideStage("方法正文第一段。");
    fireSelectionChange();
    fireEvent.click(screen.getByRole("button", { name: "复制引用" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText).toHaveBeenCalledWith("《视觉指令微调》§1.1 方法：方法正文第一段。");
    expect(useField.getState().flash?.text).toContain("已复制");
    stub.restore();
  });

  it("选区收起后浮条消失，但最近一次选中仍可供「引用解析全文」使用", () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    const stub = stubSelectionInsideStage("方法正文第一段。");
    fireSelectionChange();
    expect(screen.getByRole("toolbar", { name: "摘录到笔记" })).toBeInTheDocument();
    stub.restore();
    const collapsed = stubSelectionInsideStage("", true);
    fireSelectionChange();
    expect(screen.queryByRole("toolbar", { name: "摘录到笔记" })).toBeNull();
    collapsed.restore();
    // 打开笔记编辑框：按钮可用并把最近选中插入
    fireEvent.click(screen.getByRole("button", { name: "写总结" }));
    fireEvent.click(screen.getByRole("button", { name: "引用解析全文" }));
    expect(useField.getState().drafts.p1?.summary).toBe(
      "> 原文（[§1.1 方法](#ft-sec-1)）：方法正文第一段。",
    );
    expect(useField.getState().flash?.tone).toBe("ok");
  });

  it("没有选中时点「引用解析全文」给出指引，不动草稿", () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "写总结" }));
    fireEvent.click(screen.getByRole("button", { name: "引用解析全文" }));
    expect(useField.getState().drafts.p1?.summary).toBe("");
    expect(useField.getState().flash?.tone).toBe("warn");
    expect(useField.getState().flash?.text).toContain("先在解析全文中选中");
  });

  it("论文没有解析全文时不出现「引用解析全文」按钮", () => {
    const detail = paper();
    (detail as { parsedMarkdown: string }).parsedMarkdown = "";
    useField.setState({ mode: "field", paper: detail, selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "写总结" }));
    expect(screen.queryByRole("button", { name: "引用解析全文" })).toBeNull();
  });
});

describe("FulltextDoc · 小节锚点", () => {
  it("渲染后的全文标题按序挂上稳定锚点 id", () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    const root = document.querySelector(".ef-fulltext .ef-md") as HTMLElement;
    expect(root.querySelector("h1")?.id).toBe("ft-sec-0");
    expect(root.querySelector("h2")?.id).toBe("ft-sec-1");
  });
});

describe("本页目录 · 解析全文章节二级导航", () => {
  it("解析完成后小节列为「解析全文」下的二级项（§编号 + 标题）", () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    const intro = document.querySelector('.ef-toc a[href="#ft-sec-0"]');
    const method = document.querySelector('.ef-toc a[href="#ft-sec-1"]');
    expect(intro?.textContent).toContain("1");
    expect(intro?.textContent).toContain("引言");
    expect(method?.textContent).toContain("1.1");
    expect(method?.textContent).toContain("方法");
  });

  it("点击小节：先展开解析全文折叠区，再滚动到该节锚点", () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    const details = document.getElementById("fulltext") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    fireEvent.click(document.querySelector('.ef-toc a[href="#ft-sec-1"]')!);
    expect(details.open).toBe(true);
    expect(scrollSpy).toHaveBeenCalled();
    scrollSpy.mockRestore();
  });

  it("小节行提供「复制引用」：复制《论文+小节》引用", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "复制引用：§1.1 方法" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText).toHaveBeenCalledWith("《视觉指令微调》§1.1 方法");
    expect(useField.getState().flash?.text).toContain("已复制章节引用");
  });

  it("没有解析全文时本页目录不出现二级章节", () => {
    const detail = paper();
    (detail as { parsedMarkdown: string }).parsedMarkdown = "";
    useField.setState({ mode: "field", paper: detail, selectedPaperId: "p1" });
    renderStage();
    expect(document.querySelector(".ef-toc-sections")).toBeNull();
  });

  it("超长全文只列前 30 节并注明其余节数", () => {
    const detail = paper();
    (detail as { parsedMarkdown: string }).parsedMarkdown = Array.from(
      { length: 35 },
      (_, i) => `## 第${i}节\n\n这一节的正文。\n`,
    ).join("\n");
    useField.setState({ mode: "field", paper: detail, selectedPaperId: "p1" });
    renderStage();
    expect(document.querySelectorAll(".ef-toc-section-row").length).toBe(30);
    expect(screen.getByText("另有 5 节，展开解析全文查看。")).toBeInTheDocument();
  });
});

describe("解析全文并读面板（半高分屏）", () => {
  it("「全文并读」一键开合：面板出现、折叠区不再重复渲染", () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    const toggle = screen.getByRole("button", { name: /全文并读/ });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(document.getElementById("fulltext")).toBeTruthy();
    fireEvent.click(toggle);
    const panel = screen.getByRole("region", { name: "解析全文并读面板" });
    expect(panel).toBeInTheDocument();
    // 面板渲染全文，正文里的折叠区隐藏（锚点由面板提供，不重复）
    expect(panel.querySelector(".ef-md h1")?.id).toBe("ft-sec-0");
    expect(document.getElementById("fulltext")).toBeNull();
    expect(screen.getByRole("button", { name: /退出并读/ })).toHaveAttribute("aria-pressed", "true");
    // 一键折回单栏
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.queryByRole("region", { name: "解析全文并读面板" })).toBeNull();
    expect(document.getElementById("fulltext")).toBeTruthy();
  });

  it("面板自带小节目录：选择小节跳到对应锚点", () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: /全文并读/ }));
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    fireEvent.change(screen.getByLabelText("跳到小节"), { target: { value: "ft-sec-1" } });
    expect(scrollSpy).toHaveBeenCalled();
    const anchor = document.getElementById("ft-sec-1");
    expect(anchor?.textContent).toBe("方法");
    scrollSpy.mockRestore();
  });

  it("没有解析全文时不出现「全文并读」入口", () => {
    const detail = paper();
    (detail as { parsedMarkdown: string }).parsedMarkdown = "";
    useField.setState({ mode: "field", paper: detail, selectedPaperId: "p1" });
    renderStage();
    expect(screen.queryByRole("button", { name: /全文并读/ })).toBeNull();
  });

  it("本页目录的小节链接在并读模式下滚动面板内锚点", () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: /全文并读/ }));
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    fireEvent.click(document.querySelector('.ef-toc a[href="#ft-sec-1"]')!);
    expect(scrollSpy).toHaveBeenCalled();
    expect(document.querySelector(".ef-fulltext-panel-body #ft-sec-1")).toBeTruthy();
    scrollSpy.mockRestore();
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
