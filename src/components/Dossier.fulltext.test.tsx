import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { repo } from "../lib/repo";
import {
  completeReparseSnapshot,
  resetReparseSnapshots,
  saveReparseSnapshot,
} from "../lib/reparse";
import { resetCorrections, saveCorrection } from "../lib/parseCorrections";
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
  resetReparseSnapshots();
  resetCorrections();
});

describe("ReadingStage · 重新解析的两版对照", () => {
  it("快照还没补新版（解析进行中）：说明当前显示的仍是上一版", () => {
    saveReparseSnapshot({ paperId: "p1", markdown: "# 上一版", provider: "api" });
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    expect(screen.getByText(/正在重新解析：这里显示的仍是上一版全文/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /恢复旧版/ })).toBeNull();
  });

  it("新结果完成后展示两版对照，「采用新版」清掉快照", () => {
    saveReparseSnapshot({ paperId: "p1", markdown: "# 上一版", provider: "api" });
    completeReparseSnapshot("p1", { provider: "local", chars: 9999, sections: 4 });
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    expect(screen.getByText(/新旧版本对照/)).toBeInTheDocument();
    expect(screen.getByText(/旧版（官方 API）/)).toBeInTheDocument();
    expect(screen.getByText(/新版（本地 CLI）/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /采用新版（当前显示）/ }));
    expect(screen.queryByText(/新旧版本对照/)).toBeNull();
  });

  it("「恢复旧版」把快照里的旧全文写回库并刷新", async () => {
    saveReparseSnapshot({ paperId: "p1", markdown: "# 上一版", provider: "api" });
    completeReparseSnapshot("p1", { provider: "local", chars: 10, sections: 1 });
    const save = vi.spyOn(repo, "saveParsedMarkdown").mockResolvedValue(undefined);
    const refresh = vi.fn(async () => undefined);
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1", refresh });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: /恢复旧版/ }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("p1", "# 上一版"));
    expect(refresh).toHaveBeenCalled();
    expect(useField.getState().flash?.text).toContain("已恢复上一版解析全文");
    save.mockRestore();
  });

  it("没有快照时不渲染对照区", () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    expect(screen.queryByRole("note", { name: "新旧版本对照" })).toBeNull();
    expect(screen.queryByText(/正在重新解析/)).toBeNull();
  });
});

describe("ReadingStage · 解析完成的质量提示", () => {
  it("全文只有标题没有正文：给出疑似空页 / 正文过少提示，可关闭且本版不再出现", () => {
    const sparse = "# 引言\n\n## 方法\n\n## 实验\n\n## 结论\n\n## 讨论\n\n## 局限\n\n## 展望\n\n一句正文。";
    const p2 = { ...paper(), parsedMarkdown: sparse } as PaperDetail;
    useField.setState({ mode: "field", paper: p2, selectedPaperId: "p1" });
    renderStage();
    const note = screen.getByRole("note", { name: "解析质量提示" });
    expect(within(note).getByText(/没有正文，可能是空页/)).toBeInTheDocument();
    expect(within(note).getByText(/只解析出部分页面/)).toBeInTheDocument();
    fireEvent.click(within(note).getByRole("button", { name: "收起质量提示" }));
    expect(screen.queryByRole("note", { name: "解析质量提示" })).toBeNull();
    expect(localStorage.getItem(`paper-field.parse-quality-dismissed:p1:${sparse.length}`)).toBe("1");
  });

  it("正文充分且带表格公式的全文：不显示质量提示", () => {
    const rich = "# 引言\n\n## 方法\n\n" + "一段足够长的正文内容。\n\n".repeat(15) + "| a | b |\n|---|---|\n| 1 | 2 |\n其中 $x^2$ 为公式。";
    const p2 = { ...paper(), parsedMarkdown: rich } as PaperDetail;
    useField.setState({ mode: "field", paper: p2, selectedPaperId: "p1" });
    renderStage();
    expect(screen.queryByRole("note", { name: "解析质量提示" })).toBeNull();
  });
});

describe("ReadingStage · 解析结果的人工校正层", () => {
  it("选中段落 → 「标记解析有误…」→ 填写并保存：展示层替换该小节，提示保留原文", () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    const stub = stubSelectionInsideStage("方法正文第一段。");
    fireSelectionChange();
    fireEvent.click(screen.getByRole("button", { name: "标记解析有误…" }));
    const editor = screen.getByRole("form", { name: "编辑本地校正" });
    fireEvent.change(within(editor).getByLabelText("校正说明"), { target: { value: "公式编号错位" } });
    fireEvent.change(within(editor).getByLabelText("校正后的内容"), { target: { value: "方法正文第一段（已校正）。" } });
    fireEvent.click(within(editor).getByRole("button", { name: "保存校正" }));
    expect(useField.getState().flash?.text).toContain("仅本机展示层生效");
    // 展示层已替换
    expect(document.querySelector(".ef-fulltext .ef-md")?.textContent).toContain("方法正文第一段（已校正）。");
    expect(screen.getByRole("note", { name: "本地校正层" }).textContent).toContain("本机校正 1 处");
    expect(screen.getByRole("note", { name: "本地校正层" }).textContent).toContain("原始结果保留");
    stub.restore();
  });

  it("「放弃全部校正」恢复原始解析结果", () => {
    saveCorrection({
      paperId: "p1",
      markdown: PARSED,
      sectionId: "ft-sec-2",
      sectionLabel: "§1.1 方法",
      note: "n",
      fixed: "校正后的方法段。",
    });
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    expect(document.querySelector(".ef-fulltext .ef-md")?.textContent).toContain("校正后的方法段。");
    fireEvent.click(screen.getByRole("button", { name: /放弃全部校正/ }));
    expect(document.querySelector(".ef-fulltext .ef-md")?.textContent).toContain("方法正文第一段。");
    expect(screen.queryByRole("note", { name: "本地校正层" })).toBeNull();
    expect(useField.getState().flash?.text).toContain("恢复原始解析结果");
  });
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

describe("解析全文内检索：输入即高亮 + 命中计数 + 跳下一处", () => {
  function openFulltext() {
    document.getElementById("fulltext")?.setAttribute("open", "");
  }

  it("输入即高亮：命中全部标 mark、计数显示「第 1 / N 处」", () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    openFulltext();
    fireEvent.change(screen.getByLabelText("检索解析全文"), { target: { value: "方法" } });
    const root = document.querySelector(".ef-fulltext .ef-md") as HTMLElement;
    expect(root.querySelectorAll("mark.ef-ft-hit").length).toBe(2);
    expect(screen.getByText("第 1 / 2 处")).toBeInTheDocument();
  });

  it("「下一处」把当前命中推进并滚动；Enter 也可跳下一处", () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    openFulltext();
    const input = screen.getByLabelText("检索解析全文");
    fireEvent.change(input, { target: { value: "方法" } });
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "下一处命中" }));
    expect(screen.getByText("第 2 / 2 处")).toBeInTheDocument();
    const marks = document.querySelectorAll(".ef-fulltext .ef-md mark.ef-ft-hit");
    expect(marks[1].classList.contains("is-current")).toBe(true);
    expect(marks[0].classList.contains("is-current")).toBe(false);
    expect(scrollSpy).toHaveBeenCalled();
    // Enter 回到第一处（回绕）
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("第 1 / 2 处")).toBeInTheDocument();
    scrollSpy.mockRestore();
  });

  it("无命中显示「0 处」、跳转按钮禁用；清空检索词后高亮清除", () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    openFulltext();
    const input = screen.getByLabelText("检索解析全文");
    fireEvent.change(input, { target: { value: "不存在的词" } });
    expect(screen.getByText("0 处")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一处命中" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "" } });
    expect(document.querySelectorAll(".ef-fulltext .ef-md mark.ef-ft-hit").length).toBe(0);
    expect(screen.queryByText("0 处")).toBeNull();
  });

  it("并读面板内同样可以检索全文", () => {
    useField.setState({ mode: "field", paper: paper(), selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: /全文并读/ }));
    fireEvent.change(screen.getByLabelText("检索解析全文"), { target: { value: "引言" } });
    expect(document.querySelectorAll(".ef-fulltext-panel mark.ef-ft-hit").length).toBe(2);
    expect(screen.getByText("第 1 / 2 处")).toBeInTheDocument();
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
