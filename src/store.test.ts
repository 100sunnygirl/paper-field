import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperDetail, PaperListItem } from "./lib/types";
import { useField } from "./store";

vi.mock("./lib/repo", () => ({
  repo: {
    init: vi.fn(async () => undefined),
    getPaper: vi.fn(async () => null),
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
  },
}));

import { repo } from "./lib/repo";

function listItem(id: string): PaperListItem {
  return {
    id,
    domainId: "d-1",
    title: `论文 ${id}`,
    titleZh: null,
    abstract: "",
    year: null,
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
    firstAuthor: null,
    authorCount: 0,
    domainName: "多模态",
    domainCode: "MM-01",
  };
}

function detailOf(id: string): PaperDetail {
  return { ...listItem(id), authors: [], notes: {} as PaperDetail["notes"], domain: {} as PaperDetail["domain"], parsedMarkdown: "" };
}

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
  vi.mocked(repo.getPaper).mockReset();
  vi.mocked(repo.listArchive).mockClear();
  vi.mocked(repo.listIntake).mockClear();
  vi.mocked(repo.listPapers).mockClear();
});

describe("navigatePapers（缺陷 9：未选中时的首末落点）", () => {
  it("未选中时 ↓ 选中第 1 篇", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => detailOf(id as string));
    useField.setState({ mode: "field", papers: [listItem("a"), listItem("b"), listItem("c")], selectedPaperId: null });
    await useField.getState().navigatePapers(1);
    expect(useField.getState().selectedPaperId).toBe("a");
    expect(repo.getPaper).toHaveBeenCalledWith("a");
  });

  it("未选中时 ↑ 选中末篇", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => detailOf(id as string));
    useField.setState({ mode: "field", papers: [listItem("a"), listItem("b"), listItem("c")], selectedPaperId: null });
    await useField.getState().navigatePapers(-1);
    expect(useField.getState().selectedPaperId).toBe("c");
  });

  it("已选中第 1 篇时 ↑ 保持第 1 篇（clamp）", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => detailOf(id as string));
    useField.setState({ mode: "field", papers: [listItem("a"), listItem("b"), listItem("c")], selectedPaperId: "a" });
    await useField.getState().navigatePapers(-1);
    expect(useField.getState().selectedPaperId).toBe("a");
  });

  it("中间篇 ↓ / ↑ 正常移动", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => detailOf(id as string));
    useField.setState({ mode: "field", papers: [listItem("a"), listItem("b"), listItem("c")], selectedPaperId: "b" });
    await useField.getState().navigatePapers(1);
    expect(useField.getState().selectedPaperId).toBe("c");
    await useField.getState().navigatePapers(-1);
    expect(useField.getState().selectedPaperId).toBe("b");
  });

  it("归档模式沿归档列表导航（而非当前领域列表）", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => detailOf(id as string));
    useField.setState({
      mode: "archive",
      papers: [listItem("field-only")],
      archive: [listItem("x"), listItem("y")],
      selectedPaperId: null,
    });
    await useField.getState().navigatePapers(1);
    expect(useField.getState().selectedPaperId).toBe("x");
  });

  it("有未保存笔记时导航被拦并提示", async () => {
    useField.setState({
      mode: "field",
      papers: [listItem("a"), listItem("b")],
      selectedPaperId: null,
      unsavedNote: true,
    });
    await useField.getState().navigatePapers(1);
    expect(useField.getState().selectedPaperId).toBeNull();
    expect(useField.getState().flash).toMatchObject({ tone: "warn", text: "请先保存或取消正在编辑的笔记。" });
  });

  it("空列表时不动作", async () => {
    useField.setState({ mode: "field", papers: [] });
    await useField.getState().navigatePapers(1);
    expect(useField.getState().selectedPaperId).toBeNull();
  });
});

describe("refresh 在三种模式下的搜索接线", () => {
  it("archive 模式：listArchive 带搜索词、listIntake 不带", async () => {
    useField.setState({ mode: "archive", search: "关键词", archiveFilter: "all" });
    await useField.getState().refresh();
    expect(repo.listArchive).toHaveBeenCalledWith({ search: "关键词", openSource: "all" });
    expect(repo.listIntake).toHaveBeenCalledWith("");
    expect(repo.listPapers).not.toHaveBeenCalledWith(expect.anything(), "关键词");
  });

  it("intake 模式：listIntake 带搜索词、listArchive 不带", async () => {
    useField.setState({ mode: "intake", search: "关键词", archiveFilter: "all" });
    await useField.getState().refresh();
    expect(repo.listIntake).toHaveBeenCalledWith("关键词");
    expect(repo.listArchive).toHaveBeenCalledWith({ search: "", openSource: "all" });
  });

  it("field 模式：listPapers 带搜索词，两列表不带", async () => {
    useField.setState({ mode: "field", search: "关键词", selectedDomainId: "d-1" });
    await useField.getState().refresh();
    expect(repo.listPapers).toHaveBeenCalledWith("d-1", "关键词");
    expect(repo.listArchive).toHaveBeenCalledWith({ search: "", openSource: "all" });
    expect(repo.listIntake).toHaveBeenCalledWith("");
  });

  it("选中论文不在新列表时回落到首篇", async () => {
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => detailOf(id as string));
    vi.mocked(repo.listPapers).mockResolvedValue([listItem("a"), listItem("b")]);
    useField.setState({ mode: "field", selectedDomainId: "d-1", selectedPaperId: "gone" });
    await useField.getState().refresh();
    expect(useField.getState().selectedPaperId).toBe("a");
  });
});
