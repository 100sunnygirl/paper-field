import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repo } from "../lib/repo";
import { useField } from "../store";
import { Dock } from "./Shell";
import type { PaperListItem } from "../lib/types";

vi.mock("../lib/repo", () => ({
  repo: {
    searchAll: vi.fn(async () => [] as PaperListItem[]),
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    getPaper: vi.fn(async () => null),
  },
}));

/** 真实 App 里 Dock 的 search prop 来自 store；测试用同样的接线保证输入 → 状态 → 下拉闭环。 */
function DockFromStore() {
  const search = useField((s) => s.search);
  return <Dock domain={null} search={search} />;
}

function searchItem(id: string, title: string, domainName: string): PaperListItem {
  return {
    id,
    domainId: `d-${id}`,
    title,
    titleZh: null,
    abstract: "",
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
    tags: [],
    labs: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    firstAuthor: "Alice",
    authorCount: 1,
    domainName,
    domainCode: "MM-01",
  };
}

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
  vi.mocked(repo.searchAll).mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Dock · 搜索框三种模式", () => {
  it.each(["field", "archive", "intake"] as const)("%s 模式渲染搜索框与导入按钮", (mode) => {
    useField.setState({ mode });
    render(<DockFromStore />);
    expect(screen.getByLabelText("搜索论文")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /导入 PDF/ })).toBeInTheDocument();
  });

  it("system 模式不渲染搜索框与导入按钮", () => {
    useField.setState({ mode: "system" });
    render(<DockFromStore />);
    expect(screen.queryByLabelText("搜索论文")).toBeNull();
    expect(screen.queryByRole("button", { name: /导入 PDF/ })).toBeNull();
  });

  it("输入搜索词更新 store.search 并触发刷新（真实 setSearch）", async () => {
    useField.setState({ mode: "field" });
    render(<DockFromStore />);
    fireEvent.change(screen.getByLabelText("搜索论文"), { target: { value: "transformer" } });
    await waitFor(() => expect(useField.getState().search).toBe("transformer"));
    // refresh 已被真实 setSearch 触发（listDomains 等被调用）
    await waitFor(() => expect(repo.listDomains).toHaveBeenCalled());
  });

  it("placeholder 提示可搜字段", () => {
    useField.setState({ mode: "field" });
    render(<DockFromStore />);
    expect(screen.getByPlaceholderText("搜索标题、作者、标签或 DOI")).toBeInTheDocument();
  });
});

describe("Dock · 跨领域搜索下拉", () => {
  it("输入后防抖检索 searchAll 并展示命中数与结果", async () => {
    vi.mocked(repo.searchAll).mockResolvedValue([
      searchItem("p1", "Vision Transformer", "多模态"),
      searchItem("p2", "Transformer 解析", "指令对齐"),
    ]);
    useField.setState({ mode: "field" });
    render(<DockFromStore />);

    fireEvent.change(screen.getByLabelText("搜索论文"), { target: { value: "transformer" } });
    expect(await screen.findByText(/全部领域共匹配 2 篇/)).toBeInTheDocument();
    expect(screen.getByText("Vision Transformer")).toBeInTheDocument();
    expect(screen.getByText(/多模态 · Alice · 未读/)).toBeInTheDocument();
    expect(repo.searchAll).toHaveBeenCalledWith("transformer");
  });

  it("清空搜索词收起下拉", async () => {
    vi.mocked(repo.searchAll).mockResolvedValue([searchItem("p1", "Vision Transformer", "多模态")]);
    useField.setState({ mode: "field" });
    render(<DockFromStore />);
    const input = screen.getByLabelText("搜索论文");
    fireEvent.change(input, { target: { value: "vision" } });
    await waitFor(() => expect(screen.getByText(/全部领域共匹配 1 篇/)).toBeInTheDocument());
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(screen.queryByText(/全部领域共匹配/)).toBeNull());
  });

  it("无命中时提示调整搜索词", async () => {
    vi.mocked(repo.searchAll).mockResolvedValue([]);
    useField.setState({ mode: "archive" });
    render(<DockFromStore />);
    fireEvent.change(screen.getByLabelText("搜索论文"), { target: { value: "不存在" } });
    expect(await screen.findByText("没有匹配的论文。可以调整搜索词。")).toBeInTheDocument();
  });

  it("点击结果跳转到对应领域与论文", async () => {
    const item = searchItem("p1", "Vision Transformer", "多模态");
    vi.mocked(repo.searchAll).mockResolvedValue([item]);
    const selectDomain = vi.fn(async () => undefined);
    const selectPaper = vi.fn(async () => undefined);
    useField.setState({ mode: "intake", selectDomain, selectPaper });
    render(<DockFromStore />);

    fireEvent.change(screen.getByLabelText("搜索论文"), { target: { value: "vision" } });
    const row = await screen.findByText("Vision Transformer");
    fireEvent.click(row.closest("button")!);
    await waitFor(() => expect(selectDomain).toHaveBeenCalledWith(item.domainId));
    expect(selectPaper).toHaveBeenCalledWith("p1");
  });

  it("下拉开时按 Esc 收起且不冒泡（不触发 App 级关闭）", async () => {
    vi.mocked(repo.searchAll).mockResolvedValue([searchItem("p1", "Vision Transformer", "多模态")]);
    useField.setState({ mode: "field" });
    render(<DockFromStore />);
    const input = screen.getByLabelText("搜索论文");
    fireEvent.change(input, { target: { value: "vision" } });
    await waitFor(() => expect(screen.getByText(/全部领域共匹配 1 篇/)).toBeInTheDocument());

    const windowKeydown = vi.fn();
    window.addEventListener("keydown", windowKeydown);
    try {
      fireEvent.keyDown(input, { key: "Escape" });
    } finally {
      window.removeEventListener("keydown", windowKeydown);
    }
    await waitFor(() => expect(screen.queryByText(/全部领域共匹配/)).toBeNull());
    expect(windowKeydown).not.toHaveBeenCalled();
  });
});
