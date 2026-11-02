import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setContextFolded } from "../lib/contextFold";
import { NOTE_HINT_QUESTIONS } from "../lib/noteHints";
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
    createdAt: "2024-01-01T00:00:00.000Z",
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

  it("文件名徽章紧挨标题，但不写进标题文本", () => {
    const row = paper({});
    row.title = "smoke";
    row.fieldSources = { title: "file" };
    useField.setState({ mode: "field", paper: row });
    renderStage();
    expect(document.getElementById("paper-title")?.textContent).toBe("smoke");
    expect(screen.getByText("文件名")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "认领标题" })).toBeInTheDocument();
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

describe("ReadingStage · 资料栏「本篇状态卡」", () => {
  function completePaper(filled: Partial<Record<NoteKind, string>>): PaperDetail {
    const base = paper(filled);
    return {
      ...base,
      year: 2021,
      venue: "ICLR",
      doi: "10.5555/12345678",
      authors: [{ id: "a1", name: "甲作者", affiliation: null, lab: null, isCorresponding: false }] as PaperDetail["authors"],
      pdfPath: "/library/a.pdf",
      parsedMarkdown: "# 全文\n\n一段正文。",
    } as PaperDetail;
  }

  function card() {
    return screen.getByRole("region", { name: "本篇状态" });
  }

  it("无 PDF 的论文：解析显示「未关联 PDF」，下一步「关联 PDF」打开编辑论文信息", () => {
    useField.setState({ mode: "field", paper: paper({}), selectedPaperId: "p1" });
    renderStage();
    expect(within(card()).getByText("未关联 PDF")).toBeInTheDocument();
    expect(within(card()).getByText("0 / 5")).toBeInTheDocument();
    fireEvent.click(within(card()).getByRole("button", { name: "关联 PDF" }));
    expect(useField.getState().dialog).toBe("edit-paper");
  });

  it("著录缺项且未配置 AI：下一步「补著录信息」，提示缺几项", () => {
    // 已解析但著录不全（摘要/年份有，出处/标识符/作者缺 → 2/5）
    const parsed = { ...paper({}), pdfPath: "/library/a.pdf", parsedMarkdown: "# 全文\n\n正文。" } as PaperDetail;
    useField.setState({ mode: "field", paper: parsed, selectedPaperId: "p1" });
    renderStage();
    expect(within(card()).getByText("2 / 5")).toBeInTheDocument();
    fireEvent.click(within(card()).getByRole("button", { name: "补著录信息" }));
    expect(useField.getState().dialog).toBe("edit-paper");
    expect(within(card()).getByText(/著录还缺 3 项/)).toBeInTheDocument();
  });

  it("解析完成且著录齐全：下一步指向第一块空笔记并跳转过去", () => {
    useField.setState({
      mode: "field",
      paper: completePaper({ summary: "总结已写" }),
      selectedPaperId: "p1",
    });
    renderStage();
    expect(within(card()).getByText("已完成")).toBeInTheDocument();
    expect(within(card()).getByText("5 / 5")).toBeInTheDocument(); // 著录齐全（笔记行是 1 / 5）
    fireEvent.click(within(card()).getByRole("button", { name: "去补亮点" }));
    expect(document.querySelector('.ef-toc a[href="#note-highlights"]')).toHaveClass("is-active");
  });

  it("五块笔记写满且未读：下一步「标记已读」走 markRead", () => {
    const markRead = vi.fn(async () => undefined);
    useField.setState({
      mode: "field",
      paper: completePaper({ summary: "s", highlights: "h", weaknesses: "w", implications: "i", remarks: "r" }),
      selectedPaperId: "p1",
      markRead,
    });
    renderStage();
    fireEvent.click(within(card()).getByRole("button", { name: "标记已读" }));
    expect(markRead).toHaveBeenCalledWith("p1");
  });

  it("已读且五块写满：显示「本篇已完成」，不再给动作按钮", () => {
    const done = completePaper({ summary: "s", highlights: "h", weaknesses: "w", implications: "i", remarks: "r" });
    (done as { readingStatus: "read" }).readingStatus = "read";
    useField.setState({ mode: "field", paper: done, selectedPaperId: "p1" });
    renderStage();
    expect(within(card()).getByText("本篇已完成")).toBeInTheDocument();
    expect(within(card()).queryByRole("button")).toBeNull();
  });
});

describe("ReadingStage · 阅读状态三段条与「在读第 N 天」", () => {
  function steps() {
    return Array.from(document.querySelectorAll(".ef-read-steps span")).map((el) => ({
      text: el.textContent ?? "",
      current: el.classList.contains("is-current"),
      reached: el.classList.contains("is-reached"),
    }));
  }

  beforeEach(() => {
    localStorage.removeItem("paper-field.reading-since");
  });

  it("三段状态条高亮当前段：未读 / 在读 / 已读", () => {
    useField.setState({ mode: "field", paper: paper({}), selectedPaperId: "p1" });
    renderStage();
    expect(steps()).toEqual([
      { text: "未读", current: true, reached: false },
      { text: "在读", current: false, reached: false },
      { text: "已读", current: false, reached: false },
    ]);

    const reading = paper({});
    (reading as { readingStatus: "reading" }).readingStatus = "reading";
    act(() => {
      useField.setState({ paper: reading });
    });
    expect(steps()).toEqual([
      { text: "未读", current: false, reached: true },
      { text: "在读", current: true, reached: false },
      { text: "已读", current: false, reached: false },
    ]);

    const read = paper({});
    (read as { readingStatus: "read" }).readingStatus = "read";
    act(() => {
      useField.setState({ paper: read });
    });
    expect(steps()).toEqual([
      { text: "未读", current: false, reached: true },
      { text: "在读", current: false, reached: true },
      { text: "已读", current: true, reached: false },
    ]);
  });

  it("修改阅读状态仍走原生 select（表单语义不变）", () => {
    const setReadingStatus = vi.fn(async () => undefined);
    useField.setState({ mode: "field", paper: paper({}), selectedPaperId: "p1", setReadingStatus });
    renderStage();
    const select = screen.getByLabelText("修改阅读状态") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.value).toBe("unread");
    fireEvent.change(select, { target: { value: "reading" } });
    expect(setReadingStatus).toHaveBeenCalledWith("reading", "p1");
  });

  it("在读论文显示「在读第 N 天」（本机记录）或「入库第 N 天」（无记录回落）", () => {
    const reading = paper({});
    (reading as { readingStatus: "reading" }).readingStatus = "reading";
    useField.setState({ mode: "field", paper: reading, selectedPaperId: "p1" });
    renderStage();
    // 无本机记录：回落入库时间（夹具 createdAt 是 2024-01-01，远超一天 → 入库第 N 天）
    expect(screen.getByText(/入库第 \d+ 天/)).toBeInTheDocument();

    // 有本机记录：三天前开始读 → 在读第 4 天
    localStorage.setItem(
      "paper-field.reading-since",
      JSON.stringify({ p1: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
    );
    const fresh = paper({});
    (fresh as { readingStatus: "reading" }).readingStatus = "reading";
    act(() => {
      useField.setState({ paper: fresh });
    });
    expect(screen.getByText("在读第 4 天")).toBeInTheDocument();
  });
});

describe("ReadingStage · 标题旁的笔记进度胶囊", () => {
  it("常驻显示 x/5：点击跳到下一块空笔记并就地打开编辑器", () => {
    useField.setState({ mode: "field", paper: paper({ summary: "已写的总结" }), selectedPaperId: "p1" });
    renderStage();
    const pill = screen.getByRole("button", { name: /本篇已完成 1 \/ 5 块笔记/ });
    expect(pill.textContent).toContain("笔记 1/5");
    expect(pill).not.toHaveClass("is-full");
    fireEvent.click(pill);
    // 下一块空笔记是亮点：就地打开编辑框
    expect(screen.getByLabelText("亮点内容")).toBeInTheDocument();
  });

  it("五块写满：胶囊带对勾、aria 标注已写满；点击只滚动到笔记区", () => {
    useField.setState({
      mode: "field",
      paper: paper({ summary: "s", highlights: "h", weaknesses: "w", implications: "i", remarks: "r" }),
      selectedPaperId: "p1",
    });
    renderStage();
    const pill = screen.getByRole("button", { name: "五块笔记已写满" });
    expect(pill).toHaveClass("is-full");
    fireEvent.click(pill);
    expect(screen.queryByLabelText(/内容/)).toBeNull();
    expect(document.querySelector('.ef-toc a[href="#note-summary"]')).toHaveClass("is-active");
  });
});

describe("ReadingStage · 五块笔记写满的轻量庆祝", () => {
  it("补上最后一块（4→5）时：弹一次提示、胶囊做庆祝动画", () => {
    useField.setState({
      mode: "field",
      paper: paper({ summary: "s", highlights: "h", weaknesses: "w", implications: "i" }),
      selectedPaperId: "p1",
    });
    renderStage();
    expect(useField.getState().flash).toBeNull();
    // 保存最后一块后 store 刷新出新的 paper 对象
    act(() => {
      useField.setState({ paper: paper({ summary: "s", highlights: "h", weaknesses: "w", implications: "i", remarks: "最后一块" }) });
    });
    expect(useField.getState().flash?.tone).toBe("ok");
    expect(useField.getState().flash?.text).toContain("五块阅读笔记都写满了");
    expect(screen.getByRole("button", { name: "五块笔记已写满" })).toHaveClass("is-celebrate");
  });

  it("打开一篇本来就写满的论文不庆祝", () => {
    useField.setState({
      mode: "field",
      paper: paper({ summary: "s", highlights: "h", weaknesses: "w", implications: "i", remarks: "r" }),
      selectedPaperId: "p1",
    });
    renderStage();
    expect(useField.getState().flash).toBeNull();
    expect(screen.getByRole("button", { name: "五块笔记已写满" })).not.toHaveClass("is-celebrate");
  });
});

describe("ReadingStage · 空笔记块的研究问题提示", () => {
  beforeEach(() => {
    localStorage.removeItem("paper-field.note-hints");
  });

  it("空块显示提示问题与「写…」入口；点「写总结」仍从空白开写", () => {
    useField.setState({ mode: "field", paper: paper({}), selectedPaperId: "p1" });
    renderStage();
    expect(screen.getByText(NOTE_HINT_QUESTIONS.summary)).toBeInTheDocument();
    expect(screen.getByText(NOTE_HINT_QUESTIONS.weaknesses)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "写总结" }));
    expect(screen.getByLabelText("总结内容")).toHaveValue("");
  });

  it("收起提示：当块隐藏并写进本机记忆，重新挂载不再出现", () => {
    useField.setState({ mode: "field", paper: paper({}), selectedPaperId: "p1" });
    const { unmount } = renderStage();
    fireEvent.click(screen.getByRole("button", { name: "收起总结的提示问题" }));
    expect(screen.queryByText(NOTE_HINT_QUESTIONS.summary)).toBeNull();
    // 其他块的提示不受影响
    expect(screen.getByText(NOTE_HINT_QUESTIONS.highlights)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("paper-field.note-hints")!).summary).toBe(true);
    unmount();

    useField.setState({ mode: "field", paper: paper({}), selectedPaperId: "p1" });
    renderStage();
    expect(screen.queryByText(NOTE_HINT_QUESTIONS.summary)).toBeNull();
    expect(screen.getByText(NOTE_HINT_QUESTIONS.highlights)).toBeInTheDocument();
  });

  it("有内容或有草稿的块不显示提示", () => {
    useField.setState({ mode: "field", paper: paper({ summary: "已写" }), selectedPaperId: "p1" });
    renderStage();
    expect(screen.queryByText(NOTE_HINT_QUESTIONS.summary)).toBeNull();
    // Esc 收起留草稿的块也不算「空块」
    fireEvent.click(screen.getByRole("button", { name: "写亮点" }));
    fireEvent.change(screen.getByLabelText("亮点内容"), { target: { value: "写了一半" } });
    fireEvent.keyDown(screen.getByLabelText("亮点内容"), { key: "Escape", bubbles: true, cancelable: true });
    expect(screen.queryByText(NOTE_HINT_QUESTIONS.highlights)).toBeNull();
  });
});

describe("ReadingStage · 工作台无障碍", () => {
  it("跳转链接把焦点送到正文标题与笔记标题", () => {
    useField.setState({ mode: "field", paper: paper({}), selectedPaperId: "p1" });
    renderStage();
    const nav = screen.getByRole("navigation", { name: "跳转链接" });
    fireEvent.click(within(nav).getByRole("link", { name: "跳到正文" }));
    expect(document.activeElement?.id).toBe("paper-title");
    fireEvent.click(within(nav).getByRole("link", { name: "跳到笔记" }));
    expect(document.activeElement?.id).toBe("notes-heading");
  });

  it("正文滚动区可键盘到达并带 aria-label", () => {
    useField.setState({ mode: "field", paper: paper({}), selectedPaperId: "p1" });
    renderStage();
    const scroll = document.getElementById("read-scroll")!;
    expect(scroll.getAttribute("aria-label")).toBe("正文阅读区");
    expect(scroll.tabIndex).toBe(0);
  });

  it("切换论文时用 aria-live 播报第几篇与标题", () => {
    function listItem(id: string) {
      return { id, title: `论文 ${id}`, domainId: "d1" } as never;
    }
    useField.setState({ mode: "field", paper: paper({}), selectedPaperId: "p1", papers: [listItem("p1"), listItem("p2")] });
    renderStage();
    // 初始挂载不播报
    expect(document.querySelector(".ef-read .sr-only[role='status']")?.textContent).toBe("");
    const second = paper({});
    (second as { id: string }).id = "p2";
    (second as { titleZh: string }).titleZh = "第二篇论文";
    act(() => {
      useField.setState({ paper: second, selectedPaperId: "p2" });
    });
    expect(document.querySelector(".ef-read .sr-only[role='status']")?.textContent).toBe(
      "已切换到第 2 篇（共 2 篇）：《第二篇论文》",
    );
  });
});
