import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordDomainVisit } from "../lib/domainRecent";
import { pickPdfFiles, pickPdfFolder } from "../lib/mineru";
import { repo } from "../lib/repo";
import { useField } from "../store";
import { DeleteCheckedPapersDialog, DomainDialog, DomainPickerDialog, PaperDialog, TagCheckedPapersDialog } from "./Dialogs";
import type { Domain, Paper } from "../lib/types";

vi.mock("../lib/mineru", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mineru")>();
  return { ...actual, pickPdfFiles: vi.fn(), pickPdfFolder: vi.fn() };
});

vi.mock("../lib/repo", () => ({
  repo: {
    pdfPaths: vi.fn(async () => [] as string[]),
    importLocalPdfs: vi.fn(),
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    getPaper: vi.fn(async () => null),
    tagsOfPapers: vi.fn(async () => [] as Array<{ tag: string; count: number }>),
  },
}));

function asTauri() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
}

function paperOf(path: string): Paper {
  return {
    id: `id-${path}`,
    domainId: "d-1",
    title: path.split("/").pop() ?? path,
    titleZh: null,
    abstract: "",
    year: null,
    venue: null,
    doi: null,
    arxivId: null,
    pdfUrl: null,
    pdfPath: path,
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
  };
}

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
  vi.mocked(pickPdfFiles).mockReset();
  vi.mocked(pickPdfFolder).mockReset();
  vi.mocked(repo.importLocalPdfs).mockReset();
  vi.mocked(repo.pdfPaths).mockResolvedValue([]);
  useField.setState({ dialog: "paper", selectedDomainId: "d-1" });
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
});

describe("DeleteCheckedPapersDialog · 批量删除确认", () => {
  it("显示勾选数量，确认后调用批量删除、取消则关闭", () => {
    const deleteCheckedPapers = vi.fn(async () => undefined);
    useField.setState({ checkedPaperIds: ["a", "b", "c"], deleteCheckedPapers });
    act(() => useField.getState().openDialog("delete-checked"));
    render(<DeleteCheckedPapersDialog />);
    expect(screen.getByText("删除选中的论文？")).toBeInTheDocument();
    expect(screen.getByText(/将删除选中的/)).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(useField.getState().dialog).toBeNull();
    expect(deleteCheckedPapers).not.toHaveBeenCalled();

    act(() => useField.getState().openDialog("delete-checked"));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(deleteCheckedPapers).toHaveBeenCalledTimes(1);
  });

  it("打开后勾选集被后台刷新改动：对话框仍按打开时冻结的那批显示与删除", () => {
    useField.setState({ checkedPaperIds: ["a", "b"] });
    act(() => useField.getState().openDialog("delete-checked"));
    render(<DeleteCheckedPapersDialog />);
    act(() => useField.setState({ checkedPaperIds: ["a", "b", "x"] }));
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(useField.getState().dialogPaperIds).toEqual(["a", "b"]);
  });

  it("勾选为空时不渲染（防绕过工具栏直接开对话框）", () => {
    useField.setState({ checkedPaperIds: [] });
    act(() => useField.getState().openDialog("delete-checked"));
    render(<DeleteCheckedPapersDialog />);
    expect(screen.queryByText("删除选中的论文？")).toBeNull();
  });
});

describe("PaperDialog · 来源选择", () => {
  it("浏览器预览：不显示本机选择按钮，显示手动添加表单与说明", () => {
    render(<PaperDialog />);
    expect(screen.queryByRole("button", { name: /选择 PDF/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /选择文件夹/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "添加论文" })).toBeInTheDocument();
    const browserNote = screen.getByText(/浏览器预览不能读取本机 PDF/);
    const title = screen.getByLabelText("标题（必填）");
    expect(browserNote.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^导入/ })).toBeNull();
    expect(screen.getByRole("button", { name: "创建论文" })).toHaveClass("ef-btn-primary");
  });

  it("桌面模式：显示 选择 PDF / 选择文件夹 / 手动添加 三个入口", () => {
    asTauri();
    render(<PaperDialog />);
    expect(screen.getByRole("button", { name: /选择 PDF/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /选择文件夹/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /手动添加/ })).toBeInTheDocument();
  });
});

describe("PaperDialog · 单篇导入", () => {
  beforeEach(() => asTauri());

  it("选择多个 PDF 后列表显示文件名，导入按钮计数 2", async () => {
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf", "/papers/b.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByText("a.pdf")).toBeInTheDocument());
    expect(screen.getByText("b.pdf")).toBeInTheDocument();
    // 无重复标记
    expect(screen.queryByText("已在库中")).toBeNull();
    expect(screen.getByRole("button", { name: "导入 2" })).toBeEnabled();
  });

  it("已入库路径标记「已在库中」且不计入导入数", async () => {
    vi.mocked(repo.pdfPaths).mockResolvedValue(["/papers/a.pdf"]);
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf", "/papers/b.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByText("a.pdf")).toBeInTheDocument());
    const item = screen.getByText("a.pdf").closest("li")!;
    expect(within(item).getByText("已在库中")).toBeInTheDocument();
    expect(within(screen.getByText("b.pdf").closest("li")!).queryByText("已在库中")).toBeNull();
    expect(screen.getByRole("button", { name: "导入 1" })).toBeEnabled();
  });

  it("全部重复时不显示导入按钮", async () => {
    vi.mocked(repo.pdfPaths).mockResolvedValue(["/papers/a.pdf"]);
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByText("a.pdf")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^导入/ })).toBeNull();
  });

  it("对话框由 Rust 侧弹出（多选）；取消时列表不变、不报错", async () => {
    vi.mocked(pickPdfFiles).mockResolvedValue(null);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(pickPdfFiles).toHaveBeenCalledWith(true));
    expect(screen.getByRole("heading", { name: "添加论文" })).toBeInTheDocument();
    expect(document.querySelector(".ef-error")).toBeNull();
  });
});

describe("PaperDialog · 文件夹批量导入", () => {
  beforeEach(() => asTauri());

  it("选择文件夹列出目录下全部 PDF", async () => {
    vi.mocked(pickPdfFolder).mockResolvedValue(["/papers/folder/x.pdf", "/papers/folder/y.pdf", "/papers/folder/z.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择文件夹/ }));
    // 调用选择器不代表扫描、去重查询和 React 渲染已经完成；等待用户可见的结果。
    expect(await screen.findByText("x.pdf")).toBeInTheDocument();
    expect(pickPdfFolder).toHaveBeenCalledTimes(1);
    expect(screen.getByText("y.pdf")).toBeInTheDocument();
    expect(screen.getByText("z.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入 3" })).toBeEnabled();
  });

  it("等待文件夹选择与已入库路径查询完成后才显示扫描结果", async () => {
    let resolveFolder!: (paths: string[]) => void;
    let resolveKnown!: (paths: string[]) => void;
    vi.mocked(pickPdfFolder).mockReturnValue(new Promise((resolve) => { resolveFolder = resolve; }));
    vi.mocked(repo.pdfPaths).mockReturnValue(new Promise((resolve) => { resolveKnown = resolve; }));
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择文件夹/ }));

    expect(pickPdfFolder).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("x.pdf")).toBeNull();
    await act(async () => resolveFolder(["/papers/folder/x.pdf", "/papers/folder/y.pdf"]));
    expect(screen.queryByText("x.pdf")).toBeNull();
    expect(screen.queryByRole("button", { name: /^导入/ })).toBeNull();

    await act(async () => resolveKnown(["/papers/folder/x.pdf"]));
    const duplicate = await screen.findByText("x.pdf");
    expect(within(duplicate.closest("li")!).getByText("已在库中")).toBeInTheDocument();
    expect(screen.getByText("y.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入 1" })).toBeEnabled();
  });

  it("文件夹内已入库文件同样标重复、只导新增", async () => {
    vi.mocked(repo.pdfPaths).mockResolvedValue(["/papers/folder/x.pdf"]);
    vi.mocked(pickPdfFolder).mockResolvedValue(["/papers/folder/x.pdf", "/papers/folder/new.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择文件夹/ }));
    await waitFor(() => expect(screen.getByText("new.pdf")).toBeInTheDocument());
    expect(within(screen.getByText("x.pdf").closest("li")!).getByText("已在库中")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入 1" })).toBeEnabled();
  });
});

describe("PaperDialog · 扫描结果挑选排除", () => {
  beforeEach(() => asTauri());

  function setupScan(paths: string[]) {
    vi.mocked(pickPdfFolder).mockResolvedValue(paths);
  }

  it("扫描结果默认全部勾选，审阅条显示统计", async () => {
    setupScan(["/papers/folder/x.pdf", "/papers/folder/y.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择文件夹/ }));
    await waitFor(() => expect(screen.getByText("x.pdf")).toBeInTheDocument());
    expect(screen.getByLabelText("x.pdf")).toBeChecked();
    expect(screen.getByLabelText("y.pdf")).toBeChecked();
    expect(screen.getByText(/共 2 个待选，已勾选 2 个/)).toBeInTheDocument();
  });

  it("取消勾选后不计入导入数，导入只包含仍勾选的文件", async () => {
    setupScan(["/papers/folder/paper-a.pdf", "/papers/folder/manual.pdf", "/papers/folder/paper-b.pdf"]);
    const importPdfs = vi.fn(async (_paths: string[]) => undefined);
    useField.setState({ importPdfs });
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择文件夹/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导入 3" })).toBeEnabled());

    fireEvent.click(screen.getByLabelText("manual.pdf"));
    expect(screen.getByLabelText("manual.pdf")).not.toBeChecked();
    expect(screen.getByText(/已勾选 2 个/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入 2" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "导入 2" }));
    await waitFor(() => expect(importPdfs).toHaveBeenCalledTimes(1));
    expect(importPdfs.mock.calls[0][0]).toEqual([
      "/papers/folder/paper-a.pdf",
      "/papers/folder/paper-b.pdf",
    ]);
  });

  it("被排除的行显示删除线；重复项复选框禁用且不可勾选", async () => {
    vi.mocked(repo.pdfPaths).mockResolvedValue(["/papers/folder/known.pdf"]);
    setupScan(["/papers/folder/known.pdf", "/papers/folder/new.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择文件夹/ }));
    await waitFor(() => expect(screen.getByText("new.pdf")).toBeInTheDocument());
    expect(screen.getByLabelText("known.pdf")).toBeDisabled();
    expect(screen.getByText(/共 1 个待选，已勾选 1 个/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("new.pdf"));
    expect(screen.getByText("new.pdf").closest("li")).toHaveClass("is-excluded");
  });

  it("「全不选」清空勾选并禁用导入；「全选」恢复", async () => {
    setupScan(["/papers/folder/a.pdf", "/papers/folder/b.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择文件夹/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导入 2" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "全不选" }));
    expect(screen.getByLabelText("a.pdf")).not.toBeChecked();
    expect(screen.getByLabelText("b.pdf")).not.toBeChecked();
    expect(screen.getByText(/已勾选 0 个/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^导入/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    expect(screen.getByLabelText("a.pdf")).toBeChecked();
    expect(screen.getByRole("button", { name: "导入 2" })).toBeEnabled();
  });

  it("重新扫描同一目录保留已排除的选择", async () => {
    setupScan(["/papers/folder/a.pdf", "/papers/folder/b.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择文件夹/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导入 2" })).toBeEnabled());
    fireEvent.click(screen.getByLabelText("b.pdf"));

    // 用户再次点击「选择文件夹」重扫
    fireEvent.click(screen.getByRole("button", { name: /选择文件夹/ }));
    await waitFor(() => expect(pickPdfFolder).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("a.pdf")).toBeChecked();
    expect(screen.getByLabelText("b.pdf")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "导入 1" })).toBeEnabled();
  });
});

describe("PaperDialog · 导入执行与进度", () => {
  beforeEach(() => asTauri());

  function setupTwoPdfs() {
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf", "/papers/b.pdf"]);
  }

  it("导入中显示「正在导入 n/总数 · 当前文件」", async () => {
    setupTwoPdfs();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const importPdfs = vi.fn(async (_paths: string[], onProgress?: (done: number, total: number, current: string) => void) => {
      onProgress?.(1, 2, "a.pdf");
      await gate;
    });
    useField.setState({ importPdfs });

    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导入 2" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "导入 2" }));

    expect(await screen.findByText(/正在导入 1\/2 · a\.pdf/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入中…" })).toBeDisabled();

    release();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "导入 2" })).toBeEnabled(),
    );
    expect(screen.queryByText(/正在导入/)).toBeNull();
  });

  it("重复导入产生「跳过 N 篇已在库中」提示（真实 store 链路 + mock repo）", async () => {
    setupTwoPdfs();
    // 组件层已过滤选择时已知重复；这里模拟「导入执行时才发现 b.pdf 已入库」
    // （例如另一窗口并发导入），repo 返回 skipped → flash 汇总跳过数。
    vi.mocked(repo.importLocalPdfs).mockImplementation(async (_domainId, paths) => {
      const created: Paper[] = [];
      const skipped: string[] = [];
      for (const path of paths) {
        if (path === "/papers/b.pdf") skipped.push(path);
        else created.push(paperOf(path));
      }
      return { created, skipped };
    });

    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导入 2" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "导入 2" }));

    await waitFor(() => expect(useField.getState().dialog).toBeNull());
    const flash = useField.getState().flash;
    // 默认未配置 MinerU：入库成功但提示未解析指引（R1 无源指引）。
    expect(flash?.tone).toBe("warn");
    expect(flash?.text).toContain("已导入 1 篇，跳过 1 篇已在库中");
    expect(flash?.text).toContain("当前没有可用的 MinerU 解析源");
  });

  it("导入失败显示错误信息（如领域缺失）", async () => {
    setupTwoPdfs();
    useField.setState({ selectedDomainId: null });
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导入 2" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "导入 2" }));
    await waitFor(() => expect(screen.getByText(/先选择一个领域/)).toBeInTheDocument());
  });
});

describe("PaperDialog · 手动添加表单校验", () => {
  it("标题为空时保存被拦，显示中文提示", async () => {
    const createManualPaper = vi.fn(
      async (_input: { title: string; arxivId?: string; doi?: string; pdfPath?: string }) => undefined,
    );
    useField.setState({ createManualPaper });
    render(<PaperDialog />);

    fireEvent.click(screen.getByRole("button", { name: "创建论文" }));
    expect(
      await screen.findByText("标题必填。没有 PDF 也可以先建条目，之后可通过「编辑论文信息」补充。"),
    ).toBeInTheDocument();
    expect(createManualPaper).not.toHaveBeenCalled();
    expect(screen.getByLabelText("标题（必填）")).toHaveAttribute("aria-invalid", "true");
  });

  it("填写标题后创建成功并带出 arXiv/DOI", async () => {
    const createManualPaper = vi.fn(
      async (_input: { title: string; arxivId?: string; doi?: string; pdfPath?: string }) => undefined,
    );
    useField.setState({ createManualPaper });
    render(<PaperDialog />);

    fireEvent.change(screen.getByLabelText("标题（必填）"), { target: { value: "Attention Is All You Need" } });
    fireEvent.change(screen.getByLabelText("arXiv ID"), { target: { value: "1706.03762" } });
    fireEvent.change(screen.getByLabelText("DOI"), { target: { value: "10.5555/x" } });
    fireEvent.click(screen.getByRole("button", { name: "创建论文" }));

    await waitFor(() => expect(createManualPaper).toHaveBeenCalledTimes(1));
    expect(createManualPaper.mock.calls[0][0]).toEqual({
      title: "Attention Is All You Need",
      arxivId: "1706.03762",
      doi: "10.5555/x",
      pdfPath: undefined,
    });
    expect(screen.queryByText(/标题必填/)).toBeNull();
  });
});

describe("DomainDialog · 删除确认", () => {
  it("确认步只显示取消和确认删除领域", () => {
    const deleteDomain = vi.fn(async () => undefined);
    const updateDomain = vi.fn(async () => undefined);
    useField.setState({
      dialog: "edit-domain",
      selectedDomainId: "d-1",
      domains: [
        {
          id: "d-1",
          name: "待删领域",
          code: "D-09",
          summary: null,
          sortOrder: 1,
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      deleteDomain,
      updateDomain,
    });
    render(<DomainDialog />);
    expect(screen.getByRole("button", { name: "保存修改" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除领域…" }));
    const footer = document.querySelector(".ef-dialog-foot");
    expect(footer).not.toBeNull();
    expect(within(footer as HTMLElement).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "取消",
      "确认删除领域",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "确认删除领域" }));
    expect(deleteDomain).toHaveBeenCalledTimes(1);
    expect(updateDomain).not.toHaveBeenCalled();
  });
});

const PICKER_DOMAINS: Domain[] = [
  { id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
  { id: "d-2", name: "指令对齐", code: "AL-02", summary: null, sortOrder: 2, createdAt: "2024-01-02T00:00:00.000Z" },
  { id: "d-3", name: "强化学习", code: "RL-03", summary: null, sortOrder: 3, createdAt: "2024-01-03T00:00:00.000Z" },
];

describe("DomainPickerDialog · 搜索、最近置顶与键盘选择", () => {
  function openPicker(dialog: "pick-domain" | "move-paper" = "pick-domain", dialogPaperId: string | null = null) {
    useField.setState({ dialog, dialogPaperId, domains: PICKER_DOMAINS, selectedDomainId: "d-1" });
    return render(<DomainPickerDialog />);
  }

  beforeEach(() => {
    localStorage.clear();
  });

  it("默认第一项键盘高亮，↑↓ 移动高亮、Enter 选择对应领域", () => {
    const selectDomain = vi.fn(async () => undefined);
    useField.setState({ selectDomain });
    openPicker();
    const input = screen.getByLabelText("搜索领域");
    expect(document.querySelector('.ef-domain-option[data-index="0"]')).toHaveClass("is-active");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.querySelector('.ef-domain-option[data-index="1"]')).toHaveClass("is-active");
    expect(document.querySelector('.ef-domain-option[data-index="0"]')).not.toHaveClass("is-active");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(selectDomain).toHaveBeenCalledTimes(1);
    expect(selectDomain).toHaveBeenCalledWith("d-2");
  });

  it("↑ 在第一项上回绕到最后一项", () => {
    const selectDomain = vi.fn(async () => undefined);
    useField.setState({ selectDomain });
    openPicker();
    const input = screen.getByLabelText("搜索领域");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(document.querySelector('.ef-domain-option[data-index="2"]')).toHaveClass("is-active");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(selectDomain).toHaveBeenCalledWith("d-3");
  });

  it("输入关键词过滤：按名称或短码匹配，无匹配时提示且 Enter 不动作", () => {
    const selectDomain = vi.fn(async () => undefined);
    useField.setState({ selectDomain });
    openPicker();
    const input = screen.getByLabelText("搜索领域");

    fireEvent.change(input, { target: { value: "指令" } });
    expect(document.querySelectorAll(".ef-domain-option")).toHaveLength(1);
    expect(document.querySelector(".ef-domain-option")?.textContent).toContain("指令对齐");

    // 短码也能过滤
    fireEvent.change(input, { target: { value: "rl-03" } });
    expect(document.querySelectorAll(".ef-domain-option")).toHaveLength(1);
    expect(document.querySelector(".ef-domain-option")?.textContent).toContain("强化学习");

    fireEvent.change(input, { target: { value: "不存在的领域" } });
    expect(screen.getByText("没有匹配的领域。")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(selectDomain).not.toHaveBeenCalled();
  });

  it("最近使用的领域置顶并带「最近」角标", () => {
    recordDomainVisit("d-3");
    openPicker();
    const rows = document.querySelectorAll(".ef-domain-option");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("强化学习");
    expect(within(rows[0] as HTMLElement).getByText("最近")).toBeInTheDocument();
    expect(rows[1].textContent).toContain("多模态");
    expect(within(rows[1] as HTMLElement).queryByText("最近")).toBeNull();
  });

  it("移动模式：Enter 走 movePaper 且作用于对话框锁定的那篇论文", () => {
    const movePaper = vi.fn(async () => undefined);
    useField.setState({ movePaper });
    openPicker("move-paper", "p-9");
    expect(screen.getByText("选择这篇论文要进入的领域。")).toBeInTheDocument();
    const input = screen.getByLabelText("搜索领域");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(movePaper).toHaveBeenCalledTimes(1);
    expect(movePaper).toHaveBeenCalledWith("d-2", "p-9");
  });

  it("重新打开时清空搜索词并重置高亮", () => {
    const selectDomain = vi.fn(async () => undefined);
    useField.setState({ selectDomain });
    const { rerender } = openPicker();
    fireEvent.change(screen.getByLabelText("搜索领域"), { target: { value: "指令" } });
    act(() => useField.setState({ dialog: null }));
    rerender(<DomainPickerDialog />);
    act(() => useField.setState({ dialog: "pick-domain" }));
    rerender(<DomainPickerDialog />);
    expect(screen.getByLabelText("搜索领域")).toHaveValue("");
    expect(document.querySelectorAll(".ef-domain-option")).toHaveLength(3);
    expect(document.querySelector('.ef-domain-option[data-index="0"]')?.textContent).toContain("多模态");
  });
});

describe("DomainPickerDialog · 移动模式就地新建领域并移入", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function openMoving(createDomainAndMove?: (name: string, paperId?: string) => Promise<void>) {
    useField.setState({
      dialog: "move-paper",
      dialogPaperId: "p-9",
      domains: PICKER_DOMAINS,
      selectedDomainId: "d-1",
      ...(createDomainAndMove ? { createDomainAndMove } : {}),
    });
    return render(<DomainPickerDialog />);
  }

  it("移动模式显示「新建领域并移入」入口；切换模式不显示", () => {
    openMoving();
    expect(screen.getByRole("button", { name: "新建领域并移入" })).toBeInTheDocument();
    act(() => useField.setState({ dialog: "pick-domain" }));
    expect(screen.queryByRole("button", { name: "新建领域并移入" })).toBeNull();
  });

  it("展开输入名称后「创建并移入」一次完成建领域 + 移动", async () => {
    const createDomainAndMove = vi.fn(async () => undefined);
    openMoving(createDomainAndMove);
    fireEvent.click(screen.getByRole("button", { name: "新建领域并移入" }));
    const input = screen.getByLabelText("新领域名称");
    fireEvent.change(input, { target: { value: " 世界模型 " } });
    fireEvent.click(screen.getByRole("button", { name: "创建并移入" }));
    await waitFor(() => expect(createDomainAndMove).toHaveBeenCalledTimes(1));
    expect(createDomainAndMove).toHaveBeenCalledWith("世界模型", "p-9");
  });

  it("输入框内 Enter 同样提交；名称为空给出中文提示且不调用", () => {
    const createDomainAndMove = vi.fn(async () => undefined);
    openMoving(createDomainAndMove);
    fireEvent.click(screen.getByRole("button", { name: "新建领域并移入" }));
    const input = screen.getByLabelText("新领域名称");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("请先输入新领域的名称。")).toBeInTheDocument();
    expect(createDomainAndMove).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "世界模型" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(createDomainAndMove).toHaveBeenCalledWith("世界模型", "p-9");
  });

  it("搜索无匹配时 Enter 把搜索词带进新建输入，再 Enter 完成创建", async () => {
    const createDomainAndMove = vi.fn(async () => undefined);
    openMoving(createDomainAndMove);
    const filter = screen.getByLabelText("搜索领域");
    fireEvent.change(filter, { target: { value: "具身智能" } });
    expect(screen.getByText("没有匹配的领域。")).toBeInTheDocument();
    fireEvent.keyDown(filter, { key: "Enter" });
    const input = screen.getByLabelText("新领域名称");
    expect(input).toHaveValue("具身智能");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(createDomainAndMove).toHaveBeenCalledWith("具身智能", "p-9"));
  });

  it("创建失败时显示错误信息，输入与展开状态保留", async () => {
    const createDomainAndMove = vi.fn(async () => {
      throw new Error("领域名称必填");
    });
    openMoving(createDomainAndMove);
    fireEvent.click(screen.getByRole("button", { name: "新建领域并移入" }));
    fireEvent.change(screen.getByLabelText("新领域名称"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并移入" }));
    expect(await screen.findByText("领域名称必填")).toBeInTheDocument();
    expect(screen.getByLabelText("新领域名称")).toHaveValue("x");
  });
});

describe("TagCheckedPapersDialog · 批量标签", () => {
  beforeEach(() => {
    vi.mocked(repo.tagsOfPapers).mockReset();
    vi.mocked(repo.tagsOfPapers).mockResolvedValue([
      { tag: "benchmark", count: 3 },
      { tag: "综述", count: 1 },
    ]);
  });

  function openTagDialog() {
    useField.setState({ checkedPaperIds: ["a", "b", "c"] });
    act(() => useField.getState().openDialog("tag-checked"));
    return render(<TagCheckedPapersDialog />);
  }

  it("显示作用篇数与已有标签（含覆盖篇数）；空输入提交给中文提示", async () => {
    openTagDialog();
    expect(screen.getByText("批量修改标签")).toBeInTheDocument();
    expect(await screen.findByText("benchmark")).toBeInTheDocument();
    expect(screen.getByText("综述")).toBeInTheDocument();
    expect(screen.getByText(/这批论文已有的标签/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "添加标签" }));
    expect(screen.getByText("请先输入要添加的标签（逗号分隔，可一次多个）。")).toBeInTheDocument();
  });

  it("逗号/中文逗号分隔解析后统一添加；Enter 也可提交", async () => {
    const addTagsToChecked = vi.fn(async () => undefined);
    useField.setState({ addTagsToChecked });
    openTagDialog();
    const input = screen.getByLabelText("要添加的标签");
    fireEvent.change(input, { target: { value: "rlhf, 综述、alignment" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(addTagsToChecked).toHaveBeenCalledTimes(1));
    expect(addTagsToChecked).toHaveBeenCalledWith(["rlhf", "综述", "alignment"]);
  });

  it("点已有标签的 × 从整批移除", async () => {
    const removeTagsFromChecked = vi.fn(async () => undefined);
    useField.setState({ removeTagsFromChecked });
    openTagDialog();
    const chip = await screen.findByText("benchmark");
    fireEvent.click(screen.getByRole("button", { name: "移除标签 benchmark" }));
    await waitFor(() => expect(removeTagsFromChecked).toHaveBeenCalledWith(["benchmark"]));
    void chip;
  });

  it("勾选为空时不渲染", () => {
    useField.setState({ checkedPaperIds: [] });
    act(() => useField.getState().openDialog("tag-checked"));
    render(<TagCheckedPapersDialog />);
    expect(screen.queryByText("批量修改标签")).toBeNull();
  });
});

describe("DomainPickerDialog · 批量移动（move-checked）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("标题与说明写明作用篇数，点击领域行执行批量移动", () => {
    const moveCheckedPapers = vi.fn(async () => undefined);
    useField.setState({
      moveCheckedPapers,
      checkedPaperIds: ["a", "b"],
      domains: PICKER_DOMAINS,
      selectedDomainId: "d-1",
    });
    act(() => useField.getState().openDialog("move-checked"));
    render(<DomainPickerDialog />);
    expect(screen.getByText("移动选中论文到其他领域")).toBeInTheDocument();
    expect(screen.getByText("把选中的 2 篇论文移入哪个领域？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /指令对齐/ }));
    expect(moveCheckedPapers).toHaveBeenCalledTimes(1);
    expect(moveCheckedPapers).toHaveBeenCalledWith("d-2");
  });

  it("批量移动不提供「新建领域并移入」入口（就地新建仅单篇移动）", () => {
    useField.setState({
      checkedPaperIds: ["a"],
      domains: PICKER_DOMAINS,
      selectedDomainId: "d-1",
    });
    act(() => useField.getState().openDialog("move-checked"));
    render(<DomainPickerDialog />);
    expect(screen.queryByRole("button", { name: "新建领域并移入" })).toBeNull();
  });
});

describe("DomainPickerDialog · 手动排序（写回 sort_order）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function openSwitch() {
    useField.setState({ dialog: "pick-domain", domains: PICKER_DOMAINS, selectedDomainId: "d-1" });
    return render(<DomainPickerDialog />);
  }

  it("「调整顺序」进入排序模式：按 sort_order 列出（不受最近置顶影响），行不再点击切换", () => {
    recordDomainVisit("d-3"); // 最近置顶影响切换视图，但排序视图按 sort_order
    openSwitch();
    fireEvent.click(screen.getByRole("button", { name: "调整顺序" }));
    expect(screen.getByText(/用 ↑↓ 调整领域顺序/)).toBeInTheDocument();
    const rows = document.querySelectorAll(".ef-order-row");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("多模态");
    expect(rows[2].textContent).toContain("强化学习");
    // 排序模式下没有搜索框，也没有可点的切换行（只有 ↑↓ 调整按钮）
    expect(screen.queryByLabelText("搜索领域")).toBeNull();
    expect(document.querySelectorAll(".ef-domain-options button.ef-domain-option")).toHaveLength(0);
  });

  it("上移/下移立即写回新顺序；首行上移与末行下移禁用", () => {
    const applyDomainOrder = vi.fn(async () => undefined);
    useField.setState({ applyDomainOrder });
    openSwitch();
    fireEvent.click(screen.getByRole("button", { name: "调整顺序" }));
    expect(screen.getByRole("button", { name: "上移 多模态" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下移 强化学习" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "上移 指令对齐" }));
    expect(applyDomainOrder).toHaveBeenCalledTimes(1);
    expect(applyDomainOrder).toHaveBeenCalledWith(["d-2", "d-1", "d-3"]);
    // 本地顺序同步：指令对齐现在排第一
    const rows = document.querySelectorAll(".ef-order-row");
    expect(rows[0].textContent).toContain("指令对齐");
  });

  it("「完成排序」退出排序模式，恢复搜索与点击切换", () => {
    const selectDomain = vi.fn(async () => undefined);
    useField.setState({ selectDomain });
    openSwitch();
    fireEvent.click(screen.getByRole("button", { name: "调整顺序" }));
    fireEvent.click(screen.getByRole("button", { name: "完成排序" }));
    expect(screen.getByLabelText("搜索领域")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /指令对齐/ }));
    expect(selectDomain).toHaveBeenCalledWith("d-2");
  });
});
