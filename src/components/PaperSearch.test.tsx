import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repo } from "../lib/repo";
import { useField } from "../store";
import { PaperSearch } from "./PaperSearch";
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
    mineruCredFingerprint: null,
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

describe("PaperSearch · 列表栏搜索框", () => {
  it("输入搜索词更新 store.search 并触发刷新（真实 setSearch）", async () => {
    useField.setState({ mode: "field" });
    render(<PaperSearch />);
    fireEvent.change(screen.getByLabelText("搜索论文"), { target: { value: "transformer" } });
    await waitFor(() => expect(useField.getState().search).toBe("transformer"));
    // refresh 已被真实 setSearch 触发（listDomains 等被调用）
    await waitFor(() => expect(repo.listDomains).toHaveBeenCalled());
  });

  it("placeholder 提示可搜字段", () => {
    useField.setState({ mode: "field" });
    render(<PaperSearch />);
    expect(screen.getByPlaceholderText("搜索标题、作者或 DOI")).toBeInTheDocument();
  });

  it("有搜索词时显示清空按钮，点击清空 store.search", async () => {
    useField.setState({ mode: "field" });
    render(<PaperSearch />);
    expect(screen.queryByRole("button", { name: "清空搜索" })).toBeNull();
    fireEvent.change(screen.getByLabelText("搜索论文"), { target: { value: "vision" } });
    fireEvent.click(await screen.findByRole("button", { name: "清空搜索" }));
    await waitFor(() => expect(useField.getState().search).toBe(""));
  });
});

describe("PaperSearch · 跨领域搜索下拉", () => {
  it("输入后防抖检索 searchAll 并展示命中数与结果", async () => {
    vi.mocked(repo.searchAll).mockResolvedValue([
      searchItem("p1", "Vision Transformer", "多模态"),
      searchItem("p2", "Transformer 解析", "指令对齐"),
    ]);
    useField.setState({ mode: "field" });
    render(<PaperSearch />);

    fireEvent.change(screen.getByLabelText("搜索论文"), { target: { value: "transformer" } });
    expect(await screen.findByText(/全部领域共匹配 2 篇/)).toBeInTheDocument();
    expect(screen.getByText("Vision Transformer")).toBeInTheDocument();
    expect(screen.getByText(/多模态 · Alice · 未读/)).toBeInTheDocument();
    expect(repo.searchAll).toHaveBeenCalledWith("transformer");
  });

  it("清空搜索词收起下拉", async () => {
    vi.mocked(repo.searchAll).mockResolvedValue([searchItem("p1", "Vision Transformer", "多模态")]);
    useField.setState({ mode: "field" });
    render(<PaperSearch />);
    const input = screen.getByLabelText("搜索论文");
    fireEvent.change(input, { target: { value: "vision" } });
    await waitFor(() => expect(screen.getByText(/全部领域共匹配 1 篇/)).toBeInTheDocument());
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(screen.queryByText(/全部领域共匹配/)).toBeNull());
  });

  it("无命中时提示调整搜索词", async () => {
    vi.mocked(repo.searchAll).mockResolvedValue([]);
    useField.setState({ mode: "archive" });
    render(<PaperSearch />);
    fireEvent.change(screen.getByLabelText("搜索论文"), { target: { value: "不存在" } });
    expect(await screen.findByText("没有匹配的论文。可以调整搜索词。")).toBeInTheDocument();
  });

  it("点击结果跳转到对应领域与论文", async () => {
    const item = searchItem("p1", "Vision Transformer", "多模态");
    vi.mocked(repo.searchAll).mockResolvedValue([item]);
    const selectDomain = vi.fn(async () => undefined);
    const selectPaper = vi.fn(async () => undefined);
    useField.setState({ mode: "intake", selectDomain, selectPaper });
    render(<PaperSearch />);

    fireEvent.change(screen.getByLabelText("搜索论文"), { target: { value: "vision" } });
    const row = await screen.findByText("Vision Transformer");
    fireEvent.click(row.closest("button")!);
    await waitFor(() => expect(selectDomain).toHaveBeenCalledWith(item.domainId));
    expect(selectPaper).toHaveBeenCalledWith("p1");
  });

  it("下拉开时按 Esc 收起且不冒泡（不触发 App 级关闭）", async () => {
    vi.mocked(repo.searchAll).mockResolvedValue([searchItem("p1", "Vision Transformer", "多模态")]);
    useField.setState({ mode: "field" });
    render(<PaperSearch />);
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

describe("PaperSearch · 搜索范围显式化", () => {
  beforeEach(() => {
    localStorage.removeItem("paper-field.search-scope");
  });

  it("默认「全部领域」：输入即出跨领域下拉；切换到「当前领域」后输入只过滤列表、不再弹下拉", async () => {
    vi.mocked(repo.searchAll).mockResolvedValue([]);
    useField.setState({ mode: "field" });
    render(<PaperSearch />);

    // 默认 all：输入出下拉
    fireEvent.change(screen.getByLabelText("搜索论文"), { target: { value: "vision" } });
    expect(await screen.findByText(/全部领域共匹配/)).toBeInTheDocument();

    // 切到当前领域：下拉收起，偏好写入本机
    fireEvent.click(screen.getByRole("button", { name: "当前领域" }));
    await waitFor(() => expect(screen.queryByText(/全部领域共匹配/)).toBeNull());
    expect(localStorage.getItem("paper-field.search-scope")).toBe("domain");

    // 范围切换回全部领域：带词重新展开下拉
    fireEvent.click(screen.getByRole("button", { name: "全部领域" }));
    expect(await screen.findByText(/全部领域共匹配/)).toBeInTheDocument();
    expect(localStorage.getItem("paper-field.search-scope")).toBe("all");
  });

  it("沿用条件显式可见：下拉头写出搜索词与范围", async () => {
    vi.mocked(repo.searchAll).mockResolvedValue([searchItem("p1", "Vision Transformer", "多模态")]);
    useField.setState({ mode: "field" });
    render(<PaperSearch />);
    fireEvent.change(screen.getByLabelText("搜索论文"), { target: { value: "vision" } });
    expect(await screen.findByText(/按「vision」检索 · 全部领域共匹配 1 篇/)).toBeInTheDocument();
  });
});
