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
