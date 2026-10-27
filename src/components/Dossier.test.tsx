import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setContextFolded } from "../lib/contextFold";
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
  localStorage.removeItem("paper-field.reading-spot");
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

  it("摘要为空时直接给出编辑论文信息的入口", () => {
    useField.setState({ mode: "field", paper: paper({}, "") });
    renderStage();
    expect(screen.getByText(/摘要属于论文信息，不是笔记/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "编辑论文信息" })[0]);
    expect(useField.getState().dialog).toBe("edit-paper");
  });
});

describe("ReadingStage · 专注模式极简翻页条", () => {
  function listItem(id: string) {
    return { id, title: `论文 ${id}`, domainId: "d1" } as never;
  }

  function renderFocusStage() {
    return render(
      <ReadingStage
        focus
        onToggleFocus={() => {}}
        listOpen={false}
        onToggleList={() => {}}
        contextOpen={false}
        onToggleContext={() => {}}
      />,
    );
  }

  it("专注模式显示翻页条：上一篇 / 位置 / 标已读 / 下一篇", () => {
    useField.setState({
      mode: "field",
      paper: paper({}),
      selectedPaperId: "p1",
      papers: [listItem("p0"), listItem("p1"), listItem("p2")],
    });
    renderFocusStage();
    const pager = screen.getByRole("navigation", { name: "专注模式翻页" });
    expect(pager).toBeInTheDocument();
    expect(within(pager).getByText("2 / 3")).toBeInTheDocument();
    // 第 2 / 3 篇：两侧都可翻
    expect(within(pager).getByRole("button", { name: "上一篇论文" })).toBeEnabled();
    expect(within(pager).getByRole("button", { name: "下一篇论文" })).toBeEnabled();
  });

  it("翻页按钮走 navigatePapers，标已读走 markRead（只有用户能标）", () => {
    const navigatePapers = vi.fn(async () => undefined);
    const markRead = vi.fn(async () => undefined);
    useField.setState({
      mode: "field",
      paper: paper({}),
      selectedPaperId: "p1",
      papers: [listItem("p0"), listItem("p1"), listItem("p2")],
      navigatePapers,
      markRead,
    });
    renderFocusStage();
    fireEvent.click(screen.getByRole("button", { name: "下一篇论文" }));
    expect(navigatePapers).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "上一篇论文" }));
    expect(navigatePapers).toHaveBeenCalledWith(-1);
    fireEvent.click(screen.getByRole("button", { name: "标已读" }));
    expect(markRead).toHaveBeenCalledWith("p1");
  });

  it("第一篇时上一篇禁用；已读的论文标已读变为禁用的「已读」", () => {
    const read = paper({});
    (read as { readingStatus: "read" }).readingStatus = "read";
    useField.setState({
      mode: "field",
      paper: read,
      selectedPaperId: "p1",
      papers: [listItem("p1"), listItem("p2")],
    });
    renderFocusStage();
    expect(screen.getByRole("button", { name: "上一篇论文" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "已读" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一篇论文" })).toBeEnabled();
  });

  it("非专注模式不渲染翻页条", () => {
    useField.setState({ mode: "field", paper: paper({}), papers: [listItem("p1")] });
    renderStage();
    expect(screen.queryByRole("navigation", { name: "专注模式翻页" })).toBeNull();
  });
});

describe("ReadingStage · 按论文记忆阅读位置与现场", () => {
  it("重新打开：恢复滚动位置、目录高亮该节、展开解析全文并出现浮标", async () => {
    localStorage.setItem(
      "paper-field.reading-spot",
      JSON.stringify({ p1: { top: 320, section: "note-highlights", fulltextOpen: true, at: Date.now() - 1000 } }),
    );
    useField.setState({ mode: "field", paper: paper({ summary: "已写" }), selectedPaperId: "p1" });
    renderStage();
    await waitFor(() => expect(document.getElementById("read-scroll")?.scrollTop).toBe(320));
    expect(screen.getByText(/已回到上次阅读位置/)).toBeInTheDocument();
    expect(document.getElementById("fulltext")).toHaveAttribute("open");
    // 目录高亮恢复到离开时的小节
    expect(document.querySelector('.ef-toc a[href="#note-highlights"]')).toHaveClass("is-active");
    // 回到顶部收起浮标并把滚动归零
    fireEvent.click(screen.getByRole("button", { name: "回到顶部" }));
    expect(document.getElementById("read-scroll")?.scrollTop).toBe(0);
    expect(screen.queryByText(/已回到上次阅读位置/)).toBeNull();
  });

  it("没有现场记录时不显示浮标、不滚动", async () => {
    useField.setState({ mode: "field", paper: paper({}), selectedPaperId: "p1" });
    renderStage();
    expect(screen.queryByText(/已回到上次阅读位置/)).toBeNull();
    expect(document.getElementById("read-scroll")?.scrollTop).toBe(0);
  });

  it("滚动时节流写入现场（含所在小节与全文展开状态）", async () => {
    useField.setState({ mode: "field", paper: paper({ summary: "已写" }), selectedPaperId: "p1" });
    renderStage();
    const root = document.getElementById("read-scroll")!;
    root.scrollTop = 480;
    fireEvent.scroll(root);
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("paper-field.reading-spot")!) as { p1: { top: number } };
      expect(saved.p1.top).toBe(480);
    });
    // 节流：400ms 内的第二次滚动不落盘
    root.scrollTop = 100;
    fireEvent.scroll(root);
    const saved = JSON.parse(localStorage.getItem("paper-field.reading-spot")!) as { p1: { top: number } };
    expect(saved.p1.top).toBe(480);
  });

  it("卸载（切论文 / 离开阅读页）时兜底保存最后的现场", async () => {
    useField.setState({ mode: "field", paper: paper({ summary: "内容" }), selectedPaperId: "p1" });
    const { unmount } = renderStage();
    const root = document.getElementById("read-scroll")!;
    root.scrollTop = 640;
    fireEvent.scroll(root);
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("paper-field.reading-spot")!) as { p1: { top: number } };
      expect(saved.p1.top).toBe(640);
    });
    // 之后又滚了一段但没触发新的落盘（节流窗口内）：卸载时兜底存最后一次位置
    root.scrollTop = 900;
    unmount();
    const saved = JSON.parse(localStorage.getItem("paper-field.reading-spot")!) as { p1: { top: number } };
    expect(saved.p1.top).toBe(900);
  });
});

describe("ReadingStage · 资料栏折叠记忆与标识符一键复制", () => {
  function richPaper(): PaperDetail {
    const base = paper({});
    return {
      ...base,
      arxivId: "2103.00020",
      doi: "10.5555/12345678",
      authors: [
        { id: "a1", name: "甲作者", affiliation: "MIT", lab: "Lab M", isCorresponding: false },
        { id: "a2", name: "乙作者", affiliation: null, lab: null, isCorresponding: true },
      ] as PaperDetail["authors"],
    } as PaperDetail;
  }

  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.removeItem("paper-field.context-fold");
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  it("折叠资料与链接：内容收起、偏好写进本机 localStorage，展开恢复", () => {
    useField.setState({ mode: "field", paper: richPaper(), selectedPaperId: "p1" });
    renderStage();
    expect(screen.getByText("未提供代码仓库")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "折叠资料与链接" }));
    expect(screen.queryByText("未提供代码仓库")).toBeNull();
    expect(JSON.parse(localStorage.getItem("paper-field.context-fold")!).links).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "展开资料与链接" }));
    expect(screen.getByText("未提供代码仓库")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("paper-field.context-fold")!).links).toBe(false);
  });

  it("重新挂载按本机偏好恢复折叠（本页目录）", () => {
    // 直接走 contextFold 外部 store（localStorage 写穿在 lib 测试里覆盖）
    setContextFolded("toc", true);
    useField.setState({ mode: "field", paper: richPaper(), selectedPaperId: "p1" });
    renderStage();
    expect(screen.queryByRole("navigation", { name: "本页目录" })).toBeNull();
    expect(screen.getByRole("button", { name: "展开本页目录" })).toHaveAttribute("aria-expanded", "false");
    // 其他区块不受影响
    expect(screen.getByText("未提供代码仓库")).toBeInTheDocument();
    setContextFolded("toc", false);
  });

  it("arXiv / DOI / 作者名单一键复制到剪贴板并给出提示", async () => {
    useField.setState({ mode: "field", paper: richPaper(), selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "复制 arXiv 编号" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("2103.00020"));
    expect(useField.getState().flash?.text).toBe("已复制arXiv 编号。");

    fireEvent.click(screen.getByRole("button", { name: "复制 DOI" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("10.5555/12345678"));

    fireEvent.click(screen.getByRole("button", { name: "复制作者名单" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("甲作者, 乙作者"));
    expect(useField.getState().flash?.text).toBe("已复制作者名单。");
  });

  it("剪贴板不可用时降级提示，不抛错", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
      configurable: true,
    });
    useField.setState({ mode: "field", paper: richPaper(), selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "复制 DOI" }));
    await waitFor(() => expect(useField.getState().flash?.tone).toBe("warn"));
    expect(useField.getState().flash?.text).toContain("复制失败");
  });
});

describe("ReadingStage · 正文阅读外观（A−/A+、行宽）", () => {
  function stageStyle(): CSSStyleDeclaration {
    return document.getElementById("stage")!.style;
  }

  beforeEach(() => {
    localStorage.removeItem("paper-field.read-appearance");
  });

  it("默认标准字号与行宽（缩放变量为 1）", () => {
    useField.setState({ mode: "field", paper: paper({}), selectedPaperId: "p1" });
    renderStage();
    expect(stageStyle().getPropertyValue("--pf-read-scale")).toBe("1");
    expect(stageStyle().getPropertyValue("--pf-read-width-scale")).toBe("1");
  });

  it("A+ 增大字号：舞台变量与本篇覆盖一起更新，A− 边界禁用", () => {
    useField.setState({ mode: "field", paper: paper({}), selectedPaperId: "p1" });
    renderStage();
    fireEvent.click(screen.getByRole("button", { name: "增大正文字号" }));
    expect(stageStyle().getPropertyValue("--pf-read-scale")).toBe("1.1");
    const persisted = JSON.parse(localStorage.getItem("paper-field.read-appearance")!) as {
      papers: Record<string, { fontStep: number }>;
    };
    expect(persisted.papers.p1.fontStep).toBe(3);
    // 调过之后出现「恢复默认」
    expect(screen.getByRole("button", { name: "恢复默认" })).toBeInTheDocument();
    // 顶格后 A+ 禁用；连续 A− 回到 0 后 A− 禁用
    fireEvent.click(screen.getByRole("button", { name: "增大正文字号" }));
    expect(screen.getByRole("button", { name: "增大正文字号" })).toBeDisabled();
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole("button", { name: "减小正文字号" }));
    expect(screen.getByRole("button", { name: "减小正文字号" })).toBeDisabled();
    expect(stageStyle().getPropertyValue("--pf-read-scale")).toBe("0.85");
  });

  it("行宽三段切换与「应用到所有论文」", () => {
    useField.setState({ mode: "field", paper: paper({}), selectedPaperId: "p1" });
    renderStage();
    const group = screen.getByRole("group", { name: "正文行宽" });
    fireEvent.click(within(group).getByRole("button", { name: "宽" }));
    expect(stageStyle().getPropertyValue("--pf-read-width-scale")).toBe("1.2");
    expect(within(group).getByRole("button", { name: "宽" })).toHaveAttribute("aria-pressed", "true");
    // 应用到所有论文：本机默认更新；恢复本篇默认后仍是大字号宽行（因为默认已变）
    fireEvent.click(screen.getByRole("button", { name: "应用到所有论文" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(stageStyle().getPropertyValue("--pf-read-width-scale")).toBe("1.2");
    const persisted = JSON.parse(localStorage.getItem("paper-field.read-appearance")!) as {
      default: { width: string };
      papers: Record<string, unknown>;
    };
    expect(persisted.default.width).toBe("wide");
    expect(persisted.papers.p1).toBeUndefined();
  });
});
