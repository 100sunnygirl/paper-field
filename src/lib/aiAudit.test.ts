import { beforeEach, describe, expect, it } from "vitest";
import {
  aiWriteRecords,
  diffMeta,
  diffNotes,
  dismissAiWrite,
  latestAiWrite,
  metaValueText,
  noteVersions,
  pushNoteVersion,
  recordAiWrite,
  snapshotMeta,
  snapshotNotes,
} from "./aiAudit";
import { NOTE_DISPLAY_ORDER, type PaperDetail } from "./types";

function detail(overrides: Partial<PaperDetail> = {}): PaperDetail {
  return {
    id: "p1",
    domainId: "d1",
    title: "Old Title",
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
    mineruCredFingerprint: null,
    tags: [],
    labs: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    authors: [],
    notes: Object.fromEntries(
      NOTE_DISPLAY_ORDER.map((kind) => [
        kind,
        { id: `n-${kind}`, paperId: "p1", kind, content: "", source: "manual" as const, userEdited: false, revisedAt: null },
      ]),
    ) as PaperDetail["notes"],
    domain: { id: "d1", name: "多模态", code: "MM-01", summary: null, sortOrder: 0, createdAt: "2024-01-01T00:00:00.000Z" },
    parsedMarkdown: "",
    ...overrides,
  };
}

beforeEach(() => {
  for (const record of aiWriteRecords()) dismissAiWrite(record.id);
});

describe("diffMeta / diffNotes", () => {
  it("列出值变了的字段（旧值 → 新值），没变的不列", () => {
    const before = snapshotMeta(detail());
    const after = snapshotMeta(detail({ title: "New Title", venue: "NeurIPS", year: 2017 }));
    const changes = diffMeta(before, after);
    expect(changes.map((change) => change.field)).toEqual(["title", "year", "venue"]);
    expect(changes[0]).toMatchObject({ field: "title", from: "Old Title", to: "New Title" });
  });

  it("作者名单变化单独成行，名单文本按姓名拼接", () => {
    const before = snapshotMeta(detail());
    const after = snapshotMeta(
      detail({ authors: [{ id: "a1", name: "甲", nameZh: null, affiliation: null, lab: null, homepage: null, orcid: null, order: 0, isCorresponding: false }] }),
    );
    const changes = diffMeta(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ field: "authors", to: "甲" });
    expect(metaValueText("authors", after.authors)).toBe("甲");
  });

  it("笔记逐块比较：内容没变的块不列", () => {
    const base = detail();
    const changed = detail({
      notes: {
        ...base.notes,
        summary: { ...base.notes.summary, content: "AI 总结" },
      },
    });
    const changes = diffNotes(snapshotNotes(base), snapshotNotes(changed));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "summary", to: "AI 总结" });
  });
});

describe("写入记录（会话内）", () => {
  it("最新记录排在最前，可按论文取最新、可撤销删除", () => {
    recordAiWrite({ paperId: "a", paperTitle: "A", kind: "meta", meta: { before: snapshotMeta(detail()), after: snapshotMeta(detail()), changes: [] } });
    recordAiWrite({ paperId: "b", paperTitle: "B", kind: "notes", notes: { before: snapshotNotes(detail()), after: snapshotNotes(detail()), changes: [] } });
    expect(latestAiWrite("b")?.paperTitle).toBe("B");
    expect(latestAiWrite("a")?.paperTitle).toBe("A");
    const id = latestAiWrite("b")!.id;
    dismissAiWrite(id);
    expect(latestAiWrite("b")).toBeNull();
    expect(latestAiWrite("a")?.paperTitle).toBe("A");
  });
});

describe("笔记版本（会话内）", () => {
  it("AI 与手动版本按时间倒序记录；同内容连续重复不重复记", () => {
    pushNoteVersion("p1", "summary", "user", "第一版");
    pushNoteVersion("p1", "summary", "user", "第一版");
    pushNoteVersion("p1", "summary", "ai", "AI 草稿");
    const versions = noteVersions("p1", "summary");
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ by: "ai", content: "AI 草稿" });
    expect(versions[1]).toMatchObject({ by: "user", content: "第一版" });
  });
});
