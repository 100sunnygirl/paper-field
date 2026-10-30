import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookupPaper } from "../lib/lookup";
import { pickPdfFiles, pickPdfFolder } from "../lib/mineru";
import { repo } from "../lib/repo";
import { useField, type ImportOutcome } from "../store";
import { DeleteCheckedPapersDialog, DomainDialog, PaperDialog } from "./Dialogs";
import type { Paper } from "../lib/types";

function emptyOutcome(): ImportOutcome {
  return { created: 0, skipped: 0, failed: [] };
}

vi.mock("../lib/mineru", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mineru")>();
  return { ...actual, pickPdfFiles: vi.fn(), pickPdfFolder: vi.fn() };
});

vi.mock("../lib/lookup", () => ({
  lookupPaper: vi.fn(async () => ({ meta: null, notices: [], openalexRemainingUsd: null, openalexLimitUsd: null })),
}));

vi.mock("../lib/repo", () => ({
  repo: {
    pdfPaths: vi.fn(async () => [] as string[]),
    paperRefsForDedup: vi.fn(async () => [] as never[]),
    importLocalPdfs: vi.fn(),
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    getPaper: vi.fn(async () => null),
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
  vi.mocked(repo.paperRefsForDedup).mockResolvedValue([]);
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

describe("PaperDialog · 导入目标领域常驻可见", () => {
  beforeEach(() => {
    asTauri();
    useField.setState({
      domains: [
        { id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "d-2", name: "指令对齐", code: "AL-02", summary: null, sortOrder: 2, createdAt: "2024-01-01T00:00:00.000Z" },
      ],
    });
  });

  it("顶部常驻「将导入到：领域名」，确认按钮写明目标领域并按其导入", async () => {
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf"]);
    const importPdfs = vi.fn(
      async (
        _paths: string[],
        _onProgress?: (done: number, total: number, current: string) => void,
        _domainId?: string,
      ) => emptyOutcome(),
    );
    useField.setState({ importPdfs });
    render(<PaperDialog />);
    expect(screen.getByText("「多模态」")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导入 1 篇到「多模态」" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "导入 1 篇到「多模态」" }));
    await waitFor(() => expect(importPdfs).toHaveBeenCalledTimes(1));
    // 第三个参数显式带上目标领域（store.importPdfs 的 domainId 形参）
    expect(importPdfs.mock.calls[0][2]).toBe("d-1");
  });

  it("就地切换目标领域后，按钮与导入目标同步更换", async () => {
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf"]);
    const importPdfs = vi.fn(
      async (
        _paths: string[],
        _onProgress?: (done: number, total: number, current: string) => void,
        _domainId?: string,
      ) => emptyOutcome(),
    );
    useField.setState({ importPdfs });
    render(<PaperDialog />);

    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导入 1 篇到「多模态」" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: /将导入到/ }));
    fireEvent.click(screen.getByRole("button", { name: /指令对齐/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导入 1 篇到「指令对齐」" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "导入 1 篇到「指令对齐」" }));
    await waitFor(() => expect(importPdfs).toHaveBeenCalledTimes(1));
    expect(importPdfs.mock.calls[0][2]).toBe("d-2");
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
    const importPdfs = vi.fn(async (_paths: string[]) => emptyOutcome());
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
    const importPdfs = vi.fn(
      async (
        _paths: string[],
        onProgress?: (done: number, total: number, current: string) => void,
      ): Promise<ImportOutcome> => {
        onProgress?.(1, 2, "a.pdf");
        await gate;
        return emptyOutcome();
      },
    );
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

  it("进度行显示已用时间；完成第一篇后按均值给预计剩余", async () => {
    setupTwoPdfs();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const importPdfs = vi.fn(
      async (
        _paths: string[],
        onProgress?: (done: number, total: number, current: string) => void,
      ): Promise<ImportOutcome> => {
        onProgress?.(1, 2, "a.pdf");
        await gate;
        return emptyOutcome();
      },
    );
    useField.setState({ importPdfs });

    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导入 2" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "导入 2" }));

    const line = await screen.findByText(/正在导入 1\/2 · a\.pdf/);
    // 已用时间（秒级，几秒内必然是「0 秒」或「1 秒」档）与均值预估剩余
    expect(line.textContent).toMatch(/已用 \d+ 秒/);
    expect(line.textContent).toMatch(/预计剩余 \d+ 秒/);

    release();
    await waitFor(() => expect(screen.queryByText(/正在导入/)).toBeNull());
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

describe("PaperDialog · 手动添加粘贴识别", () => {
  const BIB = `@article{vaswani2017attention,
    title = {Attention Is All You Need},
    author = {Vaswani, Ashish},
    journal = {NeurIPS},
    year = {2017},
  }`;

  it("粘贴 arXiv 链接自动识别并填入 arXiv 字段", () => {
    render(<PaperDialog />);
    fireEvent.change(screen.getByLabelText("粘贴链接 / 标识符 / BibTeX（自动识别）"), {
      target: { value: "https://arxiv.org/abs/1706.03762v2" },
    });
    expect(screen.getByText(/已识别：arXiv 1706\.03762/)).toBeInTheDocument();
    expect(screen.getByLabelText("arXiv ID")).toHaveValue("1706.03762");
  });

  it("粘贴 BibTeX 自动拆出标题填入标题字段", () => {
    render(<PaperDialog />);
    fireEvent.change(screen.getByLabelText("粘贴链接 / 标识符 / BibTeX（自动识别）"), { target: { value: BIB } });
    expect(screen.getByText(/已识别：BibTeX「Attention Is All You Need」/)).toBeInTheDocument();
    expect(screen.getByLabelText("标题（必填）")).toHaveValue("Attention Is All You Need");
  });

  it("已手填的字段不被粘贴覆盖", () => {
    render(<PaperDialog />);
    fireEvent.change(screen.getByLabelText("标题（必填）"), { target: { value: "我的暂定标题" } });
    fireEvent.change(screen.getByLabelText("粘贴链接 / 标识符 / BibTeX（自动识别）"), { target: { value: BIB } });
    expect(screen.getByLabelText("标题（必填）")).toHaveValue("我的暂定标题");
  });

  it("粘贴 DOI 失焦查文献库回显「已找到：标题（年份）」，可一键采用", async () => {
    vi.mocked(lookupPaper).mockResolvedValueOnce({
      meta: {
        title: "Attention Is All You Need",
        titleZh: null,
        abstract: "",
        year: 2017,
        venue: "NeurIPS",
        doi: "10.5555/3294771.3295384",
        arxivId: null,
        authors: [],
        labs: [],
        codeOpenSource: "unknown",
        codeURL: null,
        projectPage: null,
        pdfURL: null,
        tags: [],
        fieldProviders: {},
      },
      notices: [],
      openalexRemainingUsd: null,
      openalexLimitUsd: null,
    });
    render(<PaperDialog />);
    const pasteBox = screen.getByLabelText("粘贴链接 / 标识符 / BibTeX（自动识别）");
    fireEvent.change(pasteBox, { target: { value: "https://doi.org/10.5555/3294771.3295384" } });
    fireEvent.blur(pasteBox);
    expect(await screen.findByText("已找到：Attention Is All You Need（2017）")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "用这个标题" }));
    expect(screen.getByLabelText("标题（必填）")).toHaveValue("Attention Is All You Need");
    expect(lookupPaper).toHaveBeenCalledWith(
      expect.objectContaining({ arxivId: null, doi: "10.5555/3294771.3295384", title: "" }),
    );
  });

  it("查不到时给诚实的后续说明，不填假著录", async () => {
    render(<PaperDialog />);
    const pasteBox = screen.getByLabelText("粘贴链接 / 标识符 / BibTeX（自动识别）");
    fireEvent.change(pasteBox, { target: { value: "1706.03762" } });
    fireEvent.blur(pasteBox);
    expect(await screen.findByText(/文献库这次没查到/)).toBeInTheDocument();
    expect(screen.getByLabelText("标题（必填）")).toHaveValue("");
  });

  it("没识别出标识符时提示可直接手填", () => {
    render(<PaperDialog />);
    fireEvent.change(screen.getByLabelText("粘贴链接 / 标识符 / BibTeX（自动识别）"), {
      target: { value: "随手敲的一句话" },
    });
    expect(screen.getByText(/未识别出 arXiv \/ DOI \/ BibTeX/)).toBeInTheDocument();
  });
});

describe("PaperDialog · 逐文件/按文件夹指定目标领域", () => {
  beforeEach(() => {
    asTauri();
    useField.setState({
      domains: [
        { id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "d-2", name: "指令对齐", code: "AL-02", summary: null, sortOrder: 2, createdAt: "2024-01-01T00:00:00.000Z" },
      ],
    });
  });

  it("多领域时行尾出现目标领域下拉，默认跟随对话框目标", async () => {
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByLabelText("目标领域：a.pdf")).toHaveValue("d-1"));
  });

  it("单领域批次仍走 importPdfs 原链路，按钮文案不变", async () => {
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf"]);
    const importPdfs = vi.fn(async () => emptyOutcome());
    const importPdfsPerFile = vi.fn(async () => emptyOutcome());
    useField.setState({ importPdfs, importPdfsPerFile });
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导入 1 篇到「多模态」" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "导入 1 篇到「多模态」" }));
    await waitFor(() => expect(importPdfs).toHaveBeenCalledTimes(1));
    expect(importPdfsPerFile).not.toHaveBeenCalled();
  });

  it("逐文件改领域后按「分入 N 个领域」走 importPdfsPerFile，条目带各自领域", async () => {
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf", "/papers/b.pdf"]);
    const importPdfs = vi.fn(async () => emptyOutcome());
    const importPdfsPerFile = vi.fn(
      async (_entries: Array<{ path: string; domainId: string }>) => emptyOutcome(),
    );
    useField.setState({ importPdfs, importPdfsPerFile });
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导入 2 篇到「多模态」" })).toBeEnabled());

    fireEvent.change(screen.getByLabelText("目标领域：b.pdf"), { target: { value: "d-2" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "导入 2 篇 · 分入 2 个领域" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "导入 2 篇 · 分入 2 个领域" }));

    await waitFor(() => expect(importPdfsPerFile).toHaveBeenCalledTimes(1));
    expect(importPdfsPerFile.mock.calls[0][0]).toEqual([
      { path: "/papers/a.pdf", domainId: "d-1" },
      { path: "/papers/b.pdf", domainId: "d-2" },
    ]);
    expect(importPdfs).not.toHaveBeenCalled();
  });

  it("「全部使用此领域」一键整批指派", async () => {
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf", "/papers/b.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByLabelText("目标领域：b.pdf")).toBeEnabled());

    fireEvent.change(screen.getByLabelText("目标领域：b.pdf"), { target: { value: "d-2" } });
    expect(screen.getByLabelText("目标领域：a.pdf")).toHaveValue("d-1");
    fireEvent.change(screen.getByLabelText("全部使用此领域"), { target: { value: "d-2" } });
    expect(screen.getByLabelText("目标领域：a.pdf")).toHaveValue("d-2");
    expect(screen.getByLabelText("目标领域：b.pdf")).toHaveValue("d-2");
  });

  it("跨文件夹扫描按目录分组，组头可整组指派", async () => {
    vi.mocked(pickPdfFolder).mockResolvedValue(["/papers/mm/x.pdf", "/papers/mm/y.pdf", "/papers/al/z.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择文件夹/ }));
    await waitFor(() => expect(screen.getByText("x.pdf")).toBeInTheDocument());

    expect(screen.getByText("mm")).toBeInTheDocument();
    expect(screen.getByText("al")).toBeInTheDocument();
    // 组头下拉整组指派 al → 指令对齐
    fireEvent.change(screen.getByLabelText("此文件夹全部使用：/papers/al"), { target: { value: "d-2" } });
    expect(screen.getByLabelText("目标领域：z.pdf")).toHaveValue("d-2");
    expect(screen.getByLabelText("目标领域：x.pdf")).toHaveValue("d-1");
  });

  it("切换对话框目标时，未单独改过的行跟随、单独改过的保留", async () => {
    useField.setState({
      domains: [
        { id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "d-2", name: "指令对齐", code: "AL-02", summary: null, sortOrder: 2, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "d-3", name: "具身智能", code: "EM-03", summary: null, sortOrder: 3, createdAt: "2024-01-01T00:00:00.000Z" },
      ],
    });
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf", "/papers/b.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByLabelText("目标领域：b.pdf")).toBeEnabled());

    fireEvent.change(screen.getByLabelText("目标领域：b.pdf"), { target: { value: "d-2" } });
    fireEvent.click(screen.getByRole("button", { name: /将导入到/ }));
    fireEvent.click(screen.getByRole("button", { name: /具身智能/ }));
    // a 没单独改过：跟随新目标 d-3；b 单独指派过：保留 d-2
    expect(screen.getByLabelText("目标领域：a.pdf")).toHaveValue("d-3");
    expect(screen.getByLabelText("目标领域：b.pdf")).toHaveValue("d-2");
  });
});

describe("PaperDialog · 重复候选（arXiv/标题跨领域比对）", () => {
  beforeEach(() => {
    asTauri();
    vi.mocked(repo.paperRefsForDedup).mockResolvedValue([
      {
        id: "p-1",
        title: "Attention Is All You Need",
        titleZh: null,
        arxivId: "1706.03762",
        doi: null,
        domainId: "d-2",
        domainName: "指令对齐",
        pdfPath: null,
        pdfOriginalPath: null,
      },
    ]);
  });

  it("同 arXiv 号的换名文件标「疑似已有」并展示匹配依据与所属领域", async () => {
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/1706.03762v2 my copy.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() =>
      expect(screen.getByText(/疑似已有 · Attention Is All You Need（指令对齐）· arXiv 1706\.03762 相同/)).toBeInTheDocument(),
    );
    // 默认仍按导入处理（保留分支）；由用户决定补充、排除或保留。
    expect(screen.getByRole("button", { name: "导入 1" })).toBeInTheDocument();
  });

  it("「补充到已有条目」调用 store 动作，行转为已补充且不再计入导入数", async () => {
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/1706.03762v2 my copy.pdf"]);
    const attachPdfToPaper = vi.fn(async () => undefined);
    useField.setState({ attachPdfToPaper });
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "补充到已有条目" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "补充到已有条目" }));
    await waitFor(() => expect(attachPdfToPaper).toHaveBeenCalledWith("p-1", "/papers/1706.03762v2 my copy.pdf"));
    expect(await screen.findByText(/已补充到「Attention Is All You Need」/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^导入/ })).toBeNull();
  });

  it("补充失败时行不转为已补充，错误就地显示", async () => {
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/1706.03762v2 my copy.pdf"]);
    const attachPdfToPaper = vi.fn(async () => {
      throw new Error("这个 PDF 已在库中");
    });
    useField.setState({ attachPdfToPaper });
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "补充到已有条目" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "补充到已有条目" }));
    await waitFor(() => expect(screen.getByText(/这个 PDF 已在库中/)).toBeInTheDocument());
    expect(screen.queryByText(/已补充到/)).toBeNull();
    expect(screen.getByRole("button", { name: "导入 1" })).toBeInTheDocument();
  });
});

describe("PaperDialog · 「已在库中」直达原条目", () => {
  beforeEach(() => {
    asTauri();
    vi.mocked(repo.pdfPaths).mockResolvedValue(["/papers/a.pdf"]);
    vi.mocked(repo.paperRefsForDedup).mockResolvedValue([
      {
        id: "p-9",
        title: "Attention Is All You Need",
        titleZh: "注意力机制",
        arxivId: null,
        doi: null,
        domainId: "d-2",
        domainName: "指令对齐",
        pdfPath: "/papers/a.pdf",
        pdfOriginalPath: "/papers/a.pdf",
      },
    ]);
  });

  it("重复行显示原条目标题与所属领域，点击关闭对话框并打开那篇论文", async () => {
    const selectDomain = vi.fn(async () => undefined);
    const selectPaper = vi.fn(async () => undefined);
    useField.setState({ selectDomain, selectPaper });
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    const link = await screen.findByRole("button", { name: /已在库中 · 注意力机制（指令对齐）/ });
    expect(link).toBeInTheDocument();

    fireEvent.click(link);
    expect(useField.getState().dialog).toBeNull();
    await waitFor(() => expect(selectDomain).toHaveBeenCalledWith("d-2"));
    await waitFor(() => expect(selectPaper).toHaveBeenCalledWith("p-9"));
  });

  it("读不到原条目信息时退回纯文字「已在库中」（不出现死链接）", async () => {
    vi.mocked(repo.paperRefsForDedup).mockResolvedValue([]);
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByText("已在库中")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /已在库中 ·/ })).toBeNull();
  });
});

describe("PaperDialog · 导入模式选项", () => {
  beforeEach(() => {
    asTauri();
    localStorage.removeItem("paper-field.import-mode");
    useField.setState({
      domains: [
        { id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
      ],
    });
  });

  it("三个模式按钮，默认选中「解析后补全」并显示本批解析源", async () => {
    useField.setState({ effectiveProvider: "local" });
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导入 1 篇到「多模态」" })).toBeEnabled());
    expect(screen.getByRole("group", { name: "导入模式" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解析后补全" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/本批解析源：本地 CLI/)).toBeInTheDocument();
  });

  it("选择「只入库」后导入不提交解析（flash 说明）", async () => {
    vi.mocked(repo.importLocalPdfs).mockResolvedValue({ created: [paperOf("/papers/a.pdf")], skipped: [] });
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导入 1 篇到「多模态」" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "只入库" }));
    fireEvent.click(screen.getByRole("button", { name: "导入 1 篇到「多模态」" }));
    await waitFor(() => expect(useField.getState().flash?.text).toContain("未提交解析"));
    expect(useField.getState().flash?.tone).toBe("ok");
  });

  it("模式记住上次选择：localStorage 为 library 时重开仍是「只入库」", async () => {
    localStorage.setItem("paper-field.import-mode", "library");
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /导入 1 篇到/ })).toBeEnabled());
    expect(screen.getByRole("button", { name: "只入库" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "解析后补全" })).toHaveAttribute("aria-pressed", "false");
  });

  it("未配置解析源时提示可先「只入库」", async () => {
    useField.setState({ effectiveProvider: null, mineru: { ...useField.getState().mineru, configured: false } });
    vi.mocked(pickPdfFiles).mockResolvedValue(["/papers/a.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导入 1 篇到「多模态」" })).toBeEnabled());
    expect(screen.getByText(/尚未配置解析源，可选「只入库」/)).toBeInTheDocument();
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
