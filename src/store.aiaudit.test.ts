import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlEngine } from "./lib/engine";

const holder = vi.hoisted(() => ({ engine: null as SqlEngine | null }));

vi.mock("./lib/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/engine")>();
  return { ...actual, getEngine: () => Promise.resolve(holder.engine!) };
});

vi.mock("./lib/lookup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/lookup")>();
  return { ...actual, lookupPaper: vi.fn() };
});

vi.mock("./lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/settings")>();
  return {
    ...actual,
    completeChat: vi.fn(),
    cancelChat: vi.fn(async () => undefined),
  };
});

import { makeTestEngine, type TestEngineHandle } from "./test/helpers";
import { latestAiWrite, noteVersions } from "./lib/aiAudit";
import { lookupPaper } from "./lib/lookup";
import { repo } from "./lib/repo";
import { completeChat } from "./lib/settings";
import { useField } from "./store";

const usable = {
  version: 2 as const,
  usage: {},
  providers: [
    {
      id: "a",
      presetId: "deepseek",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      enabled: true,
      hasKey: true,
      requiresKey: true,
    },
  ],
};

let handle: TestEngineHandle;

beforeEach(async () => {
  handle = await makeTestEngine();
  holder.engine = handle.engine;
  await handle.engine.execute("DELETE FROM app_meta");
  vi.mocked(lookupPaper).mockReset();
  vi.mocked(completeChat).mockReset();
  useField.setState({ ...useField.getInitialState(), settings: usable, ready: true }, true);
});

describe("AI 写入审计与撤销（快照还原）", () => {
  it("补全完成后记录前后快照；撤销把字段恢复为写入前的值", async () => {
    const domain = await repo.createDomain({ name: "多模态", code: "MM-01" });
    // 文件名标题（来源 file）：文献库在 overwrite=false 下也能替换它。
    const paper = await repo.createPaper({
      domainId: domain.id,
      pdfPath: "library/xxx.pdf",
      pdfOriginalPath: "/papers/文件名标题.pdf",
    });
    vi.mocked(lookupPaper).mockResolvedValue({
      meta: {
        title: "Real Title",
        titleZh: null,
        abstract: "biblio abstract",
        year: 2017,
        venue: null,
        doi: null,
        arxivId: null,
        authors: [],
        labs: [],
        codeOpenSource: "unknown",
        codeURL: null,
        projectPage: null,
        pdfURL: null,
        tags: [],
      },
      notices: [],
      openalexRemainingUsd: null,
      openalexLimitUsd: null,
    });
    vi.mocked(completeChat).mockResolvedValue("{}");

    await useField.getState().runPrepareMeta(paper.id, false);

    const after = (await repo.getPaper(paper.id))!;
    expect(after.title).toBe("Real Title");
    expect(after.abstract).toBe("biblio abstract");

    const record = latestAiWrite(paper.id);
    expect(record?.kind).toBe("meta");
    expect(record?.meta?.changes.map((change) => change.field)).toEqual(expect.arrayContaining(["title", "abstract", "year"]));
    expect(record?.meta?.before.title).toContain("文件名标题");

    await useField.getState().undoAiWrite(record!.id);

    const restored = (await repo.getPaper(paper.id))!;
    expect(restored.title).toContain("文件名标题");
    expect(restored.abstract).toBe("");
    expect(restored.year).toBeNull();
    // 撤销后记录清掉：再撤销提示记录不存在。
    expect(latestAiWrite(paper.id)).toBeNull();
  });

  it("AI 写入之后用户又改过的字段不被撤销覆盖（人工修改保护）", async () => {
    const domain = await repo.createDomain({ name: "多模态", code: "MM-02" });
    const paper = await repo.createPaper({ domainId: domain.id, title: "用户标题", userOwned: true });
    vi.mocked(lookupPaper).mockResolvedValue({
      meta: {
        title: "Real Title",
        titleZh: null,
        abstract: "biblio abstract",
        year: null,
        venue: null,
        doi: null,
        arxivId: null,
        authors: [],
        labs: [],
        codeOpenSource: "unknown",
        codeURL: null,
        projectPage: null,
        pdfURL: null,
        tags: [],
      },
      notices: [],
      openalexRemainingUsd: null,
      openalexLimitUsd: null,
    });
    vi.mocked(completeChat).mockResolvedValue("{}");
    // 确认覆盖语义（overwrite=true）：文献库值替换手动标题。
    await useField.getState().runPrepareMeta(paper.id, true);
    const record = latestAiWrite(paper.id)!;
    expect(record.meta?.changes.map((change) => change.field)).toContain("title");

    // 用户在查看 diff 期间手动改了标题：撤销不得覆盖。
    await repo.updatePaper(paper.id, { title: "我改的标题" }, true);

    await useField.getState().undoAiWrite(record.id);
    const restored = (await repo.getPaper(paper.id))!;
    expect(restored.title).toBe("我改的标题");
    expect(restored.abstract).toBe(""); // 未被再改的字段照常恢复
    expect(useField.getState().flash?.tone).toBe("ok");
    expect(useField.getState().flash?.text).toContain("保留你的值");
  });

  it("起草完成记笔记版本（AI 版本）；撤销恢复写前内容并记手动版本", async () => {
    const domain = await repo.createDomain({ name: "多模态", code: "MM-03" });
    const paper = await repo.createPaper({ domainId: domain.id, title: "Paper" });
    vi.mocked(completeChat).mockResolvedValue(
      JSON.stringify({
        remarks: "",
        summary: "AI 总结",
        highlights: "AI 亮点",
        weaknesses: "",
        implications: "",
      }),
    );
    await useField.getState().runDraftNotes(paper.id, false);

    const record = latestAiWrite(paper.id)!;
    expect(record.kind).toBe("notes");
    expect(record.notes?.changes.map((change) => change.kind).sort()).toEqual(["highlights", "summary"]);
    expect(noteVersions(paper.id, "summary")[0]).toMatchObject({ by: "ai", content: "AI 总结" });

    await useField.getState().undoAiWrite(record.id);
    const after = (await repo.getPaper(paper.id))!;
    expect(after.notes.summary.content).toBe("");
    expect(after.notes.highlights.content).toBe("");
    // 撤销本身记为手动版本；块来源沿用「AI 起草 · 人工修订」语义（userEdited 标记人工修订）。
    expect(noteVersions(paper.id, "summary")[0]).toMatchObject({ by: "user", content: "" });
    expect(after.notes.summary.userEdited).toBe(true);
  });

  it("手动保存笔记也记版本；restoreNoteVersion 恢复所选版本", async () => {
    const domain = await repo.createDomain({ name: "多模态", code: "MM-04" });
    const paper = await repo.createPaper({ domainId: domain.id, title: "Paper" });
    await repo.updateNote(paper.id, "summary", "第一版", "manual", true);
    await useField.getState().saveNote(paper.id, "summary", "第二版");
    // saveNote 落库前把「第一版」记为手动版本。
    expect(noteVersions(paper.id, "summary")).toHaveLength(1);
    expect(noteVersions(paper.id, "summary")[0]).toMatchObject({ by: "user", content: "第一版" });

    await useField.getState().restoreNoteVersion(paper.id, "summary", "第一版");
    const after = (await repo.getPaper(paper.id))!;
    expect(after.notes.summary.content).toBe("第一版");
    expect(useField.getState().flash?.text).toContain("恢复到所选版本");
  });
});

describe("干跑预览（先预览不写入）", () => {
  it("dryRun 只查询与生成不写库；applyMetaPreview 确认后按载荷写入并记审计", async () => {
    const domain = await repo.createDomain({ name: "多模态", code: "MM-05" });
    const paper = await repo.createPaper({
      domainId: domain.id,
      pdfPath: "library/y.pdf",
      pdfOriginalPath: "/papers/文件名标题.pdf",
    });
    vi.mocked(lookupPaper).mockResolvedValue({
      meta: {
        title: "Real Title",
        titleZh: null,
        abstract: "biblio abstract",
        year: 2017,
        venue: null,
        doi: null,
        arxivId: null,
        authors: [],
        labs: [],
        codeOpenSource: "unknown",
        codeURL: null,
        projectPage: null,
        pdfURL: null,
        tags: [],
      },
      notices: [],
      openalexRemainingUsd: null,
      openalexLimitUsd: null,
    });
    vi.mocked(completeChat).mockResolvedValue(
      JSON.stringify({ titleZh: "中文标题", tags: ["llm-tag"], authors: [], labs: [], codeOpenSource: "unknown" }),
    );

    await useField.getState().runPrepareMeta(paper.id, false, false, { dryRun: true });

    // 干跑：不写库。
    const mid = (await repo.getPaper(paper.id))!;
    expect(mid.title).toContain("文件名标题");
    expect(mid.titleZh).toBeNull();
    // 预览已生成并自动打开对话框。
    const preview = useField.getState().metaPreview!;
    expect(preview.paperId).toBe(paper.id);
    expect(useField.getState().dialog).toBe("ai-preview");
    expect(useField.getState().dialogPaperId).toBe(paper.id);
    // 预览列出两段合并后的拟写入字段（文献库 + 模型）。
    const fields = preview.changes.map((change) => change.field);
    expect(fields).toEqual(expect.arrayContaining(["title", "abstract", "year", "titleZh"]));
    const titleChange = preview.changes.find((change) => change.field === "title")!;
    expect(titleChange.incoming).toBe("api");
    expect(titleChange.to).toBe("Real Title");
    expect(preview.changes.find((change) => change.field === "titleZh")!.incoming).toBe("llm");

    // 确认写入：按同一载荷落库，并留下可撤销的审计记录。
    await useField.getState().applyMetaPreview();

    const after = (await repo.getPaper(paper.id))!;
    expect(after.title).toBe("Real Title");
    expect(after.titleZh).toBe("中文标题");
    expect(useField.getState().metaPreview).toBeNull();
    expect(useField.getState().dialog).toBeNull();
    const record = latestAiWrite(paper.id)!;
    expect(record.kind).toBe("meta");
    expect(record.meta?.before.title).toContain("文件名标题");
    expect(record.meta?.after.title).toBe("Real Title");
  });

  it("dryRun 期间字段级白名单照常生效：未勾选的手动字段不出现在预览里", async () => {
    const domain = await repo.createDomain({ name: "多模态", code: "MM-06" });
    const paper = await repo.createPaper({ domainId: domain.id, title: "用户标题", userOwned: true });
    vi.mocked(lookupPaper).mockResolvedValue({
      meta: {
        title: "API 标题",
        titleZh: null,
        abstract: "",
        year: null,
        venue: null,
        doi: null,
        arxivId: null,
        authors: [],
        labs: [],
        codeOpenSource: "unknown",
        codeURL: null,
        projectPage: null,
        pdfURL: null,
        tags: [],
      },
      notices: [],
      openalexRemainingUsd: null,
      openalexLimitUsd: null,
    });
    vi.mocked(completeChat).mockResolvedValue("{}");

    // overwrite=true 但白名单不含 title：预览不应列 title（不会被替换）。
    await useField.getState().runPrepareMeta(paper.id, true, false, { dryRun: true, allowFields: [] });
    const preview = useField.getState().metaPreview!;
    expect(preview.changes.map((change) => change.field)).not.toContain("title");

    // 放弃预览：不写库。
    useField.getState().dismissMetaPreview();
    const after = (await repo.getPaper(paper.id))!;
    expect(after.title).toBe("用户标题");
    expect(useField.getState().dialog).toBeNull();
  });

  it("预览期间手改的字段在确认写入时保留（meta_rev 条件更新保护）", async () => {
    const domain = await repo.createDomain({ name: "多模态", code: "MM-07" });
    const paper = await repo.createPaper({
      domainId: domain.id,
      pdfPath: "library/z.pdf",
      pdfOriginalPath: "/papers/文件名标题.pdf",
    });
    vi.mocked(lookupPaper).mockResolvedValue({
      meta: {
        title: "Real Title",
        titleZh: null,
        abstract: "biblio abstract",
        year: null,
        venue: null,
        doi: null,
        arxivId: null,
        authors: [],
        labs: [],
        codeOpenSource: "unknown",
        codeURL: null,
        projectPage: null,
        pdfURL: null,
        tags: [],
      },
      notices: [],
      openalexRemainingUsd: null,
      openalexLimitUsd: null,
    });
    vi.mocked(completeChat).mockResolvedValue("{}");
    await useField.getState().runPrepareMeta(paper.id, true, false, { dryRun: true });

    // 预览期间用户手改摘要（user 来源）。
    await repo.updatePaper(paper.id, { abstract: "我自己的摘要" }, true);

    await useField.getState().applyMetaPreview();
    const after = (await repo.getPaper(paper.id))!;
    expect(after.abstract).toBe("我自己的摘要");
    expect(after.title).toBe("Real Title"); // 未被再改的字段照常写入
  });
});
