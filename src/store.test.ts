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
    listFailedMineru: vi.fn(async () => [] as string[]),
    createDomain: vi.fn(),
    setMineruState: vi.fn(async () => undefined),
  },
}));

import { DEFAULT_MINERU } from "./lib/mineru";
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
  vi.mocked(repo.listFailedMineru).mockReset();
  vi.mocked(repo.setMineruState).mockReset();
  vi.mocked(repo.createDomain).mockReset();
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

describe("retryFailedMineru（INTAKE 批量重试）", () => {
  const configuredMineru = {
    ...DEFAULT_MINERU,
    ssh: { ...DEFAULT_MINERU.ssh, enabled: true },
    configured: true,
  };

  it("把全部解析失败论文重置为 queued 并重新排队", async () => {
    vi.mocked(repo.listFailedMineru).mockResolvedValue(["e1", "e2"]);
    useField.setState({ mineru: configuredMineru });

    await useField.getState().retryFailedMineru();

    expect(repo.setMineruState).toHaveBeenCalledTimes(2);
    expect(repo.setMineruState).toHaveBeenCalledWith("e1", {
      status: "queued",
      error: null,
      parseId: null,
      parseIds: [],
      docRef: null,
      provider: null,
    });
    const flash = useField.getState().flash;
    expect(flash?.tone).toBe("ok");
    expect(flash?.text).toContain("已将 2 篇重新发送到 MinerU 解析");
  });

  it("没有失败论文时提示且不动数据", async () => {
    vi.mocked(repo.listFailedMineru).mockResolvedValue([]);
    useField.setState({ mineru: configuredMineru });

    await useField.getState().retryFailedMineru();

    expect(repo.setMineruState).not.toHaveBeenCalled();
    expect(useField.getState().flash?.text).toBe("没有解析失败的论文。");
  });

  it("未配置解析源时给出设置页指引", async () => {
    vi.mocked(repo.listFailedMineru).mockResolvedValue(["e1"]);
    useField.setState({ mineru: DEFAULT_MINERU });

    await useField.getState().retryFailedMineru();

    expect(repo.setMineruState).not.toHaveBeenCalled();
    expect(useField.getState().flash?.text).toContain("尚未启用任何 MinerU 解析源");
  });
});

describe("createDomain / updateDomain（仅名称必填）", () => {
  it("缺少名称时报「领域名称必填」，不再要求短码", async () => {
    await expect(useField.getState().createDomain({ name: "  ", code: "MM-1" })).rejects.toThrow(
      "领域名称必填",
    );
  });

  it("短码留空也能创建", async () => {
    vi.mocked(repo.createDomain).mockResolvedValue({
      id: "d-new",
      name: "多模态",
      code: "D-01",
      summary: null,
      sortOrder: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    await useField.getState().createDomain({ name: "多模态", code: "" });
    expect(repo.createDomain).toHaveBeenCalledWith({ name: "多模态", code: "" });
  });
});
