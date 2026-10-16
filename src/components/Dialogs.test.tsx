import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listPdfs, normalizePdf } from "../lib/mineru";
import { repo } from "../lib/repo";
import { useField } from "../store";
import { DeleteCheckedPapersDialog, DomainDialog, PaperDialog } from "./Dialogs";
import type { Paper } from "../lib/types";

vi.mock("../lib/mineru", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mineru")>();
  return { ...actual, listPdfs: vi.fn(), normalizePdf: vi.fn() };
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
  vi.mocked(openDialog).mockReset();
  vi.mocked(listPdfs).mockReset();
  vi.mocked(normalizePdf).mockReset();
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
    useField.setState({
      dialog: "delete-checked",
      checkedPaperIds: ["a", "b", "c"],
      deleteCheckedPapers,
    });
    render(<DeleteCheckedPapersDialog />);
    expect(screen.getByText("删除选中的论文？")).toBeInTheDocument();
    expect(screen.getByText(/将删除选中的/)).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(useField.getState().dialog).toBeNull();
    expect(deleteCheckedPapers).not.toHaveBeenCalled();

    act(() => {
      useField.setState({ dialog: "delete-checked" });
    });
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(deleteCheckedPapers).toHaveBeenCalledTimes(1);
  });

  it("勾选为空时不渲染（防绕过工具栏直接开对话框）", () => {
    useField.setState({ dialog: "delete-checked", checkedPaperIds: [] });
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
    vi.mocked(openDialog).mockResolvedValue(["/papers/a.pdf", "/papers/b.pdf"]);
    vi.mocked(normalizePdf).mockImplementation(async (path: string) => path);
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
    vi.mocked(openDialog).mockResolvedValue(["/papers/a.pdf", "/papers/b.pdf"]);
    vi.mocked(normalizePdf).mockImplementation(async (path: string) => path);
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
    vi.mocked(openDialog).mockResolvedValue("/papers/a.pdf");
    vi.mocked(normalizePdf).mockImplementation(async (path: string) => path);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择 PDF/ }));
    await waitFor(() => expect(screen.getByText("a.pdf")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^导入/ })).toBeNull();
  });
});

describe("PaperDialog · 文件夹批量导入", () => {
  beforeEach(() => asTauri());

  it("选择文件夹列出目录下全部 PDF", async () => {
    vi.mocked(openDialog).mockResolvedValue("/papers/folder");
    vi.mocked(listPdfs).mockResolvedValue(["/papers/folder/x.pdf", "/papers/folder/y.pdf", "/papers/folder/z.pdf"]);
    render(<PaperDialog />);
    fireEvent.click(screen.getByRole("button", { name: /选择文件夹/ }));
    await waitFor(() => expect(listPdfs).toHaveBeenCalledWith("/papers/folder"));
    expect(screen.getByText("x.pdf")).toBeInTheDocument();
    expect(screen.getByText("y.pdf")).toBeInTheDocument();
    expect(screen.getByText("z.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入 3" })).toBeEnabled();
  });

  it("文件夹内已入库文件同样标重复、只导新增", async () => {
    vi.mocked(repo.pdfPaths).mockResolvedValue(["/papers/folder/x.pdf"]);
    vi.mocked(openDialog).mockResolvedValue("/papers/folder");
    vi.mocked(listPdfs).mockResolvedValue(["/papers/folder/x.pdf", "/papers/folder/new.pdf"]);
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
    vi.mocked(openDialog).mockResolvedValue("/papers/folder");
    vi.mocked(listPdfs).mockResolvedValue(paths);
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
    await waitFor(() => expect(listPdfs).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("a.pdf")).toBeChecked();
    expect(screen.getByLabelText("b.pdf")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "导入 1" })).toBeEnabled();
  });
});

describe("PaperDialog · 导入执行与进度", () => {
  beforeEach(() => asTauri());

  function setupTwoPdfs() {
    vi.mocked(openDialog).mockResolvedValue(["/papers/a.pdf", "/papers/b.pdf"]);
    vi.mocked(normalizePdf).mockImplementation(async (path: string) => path);
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
