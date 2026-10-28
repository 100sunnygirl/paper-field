import { describe, expect, it } from "vitest";
import { NOTE_KINDS } from "./types";
import {
  defaultNotePermit,
  diffStage,
  libraryLabel,
  noteWriteNeeded,
  partitionTitles,
  readingUndoPlan,
  stageProseFrom,
  type StageProse,
} from "./readingHolds";
import type { PaperDetail } from "./types";

function paper(over: Partial<PaperDetail> = {}): PaperDetail {
  const notes = Object.fromEntries(
    NOTE_KINDS.map((kind) => [kind, { id: kind, paperId: "p", kind, content: "", source: "manual" as const, userEdited: false, rev: 0, revisedAt: null }]),
  ) as PaperDetail["notes"];
  return {
    id: "p",
    domainId: "d",
    title: "Title",
    titleZh: "标题",
    abstract: "abs",
    year: 2024,
    venue: "Venue",
    doi: "10.1/x",
    arxivId: "2401.00001",
    pdfUrl: null,
    pdfPath: null,
    codeUrl: "https://example.com/code",
    codeOpenSource: "unknown",
    projectPage: null,
    readingStatus: "unread",
    readAt: null,
    llmPreparedAt: null,
    notesDraftedByLlm: false,
    userNotesTouched: false,
    userMetaTouched: false,
    tags: [],
    labs: [],
    createdAt: "",
    updatedAt: "",
    mineruStatus: null,
    mineruParseId: null,
    mineruDocRef: null,
    mineruError: null,
    mineruParseIds: [],
    mineruProvider: null,
    mineruCredFingerprint: null,
    authors: [{ id: "a", name: "Ada", nameZh: null, affiliation: null, lab: null, homepage: null, orcid: null, order: 0, isCorresponding: false }],
    notes,
    domain: { id: "d", name: "D", code: "D-1", summary: null, sortOrder: 0, createdAt: "" },
    parsedMarkdown: "",
    ...over,
  };
}

describe("reading holds", () => {
  it("skips an unchanged note string and treats a space as a change", () => {
    expect(noteWriteNeeded("same", "same")).toBe(false);
    expect(noteWriteNeeded("same", "same ")).toBe(true);
  });

  it("leaves user-edited blocks and open drafts unchecked", () => {
    const notes = Object.fromEntries(NOTE_KINDS.map((kind) => [kind, { userEdited: kind === "summary" }]));
    const permit = defaultNotePermit(notes, { highlights: "draft" });
    expect(permit.summary).toBe(false);
    expect(permit.highlights).toBe(false);
    expect(permit.remarks).toBe(true);
    expect(NOTE_KINDS.every((kind) => kind in permit)).toBe(true);
  });

  it("restores a null reading stamp by clearing it first", () => {
    expect(readingUndoPlan({ status: "reading", readAt: null })).toEqual(["unread", "reading"]);
    expect(readingUndoPlan({ status: "unread", readAt: null })).toEqual(["unread"]);
    expect(readingUndoPlan({ status: "reading", readAt: "2024-01-01" })).toEqual(["reading"]);
  });

  it("names a filename title and falls back when both titles are blank", () => {
    expect(libraryLabel("file.pdf", null)).toBe("file.pdf");
    expect(libraryLabel("file.pdf", "中文")).toBe("中文");
    expect(libraryLabel("  ", "  ")).toBe("未命名论文");
  });

  it("marks only the fields the saved row changed", () => {
    const prose: StageProse = stageProseFrom(paper());
    expect(diffStage(prose, paper({ title: "Other" }))).toEqual(["title"]);
    expect(diffStage(prose, paper({ doi: "10.2/y" }))).toContain("doi");
  });

  it("partitions by paper id, caps each bucket, and marks a rename", () => {
    const diff = partitionTitles(
      [
        { id: "a", label: "只在当前" },
        { id: "b", label: "旧名" },
        { id: "a", label: "重复忽略" },
      ],
      [
        { id: "b", label: "新名" },
        { id: "c", label: "只在备份" },
        { id: "", label: "空" },
      ],
      8,
    );
    expect(diff.onlyCurrent.rows).toEqual([{ id: "a", label: "只在当前" }]);
    expect(diff.onlyBackup.rows).toEqual([{ id: "c", label: "只在备份" }]);
    expect(diff.both.rows).toEqual([{ id: "b", label: "旧名", backupLabel: "新名", renamed: true }]);

    const capped = partitionTitles(
      Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, label: `文${i}` })),
      [],
      8,
    );
    expect(capped.onlyCurrent.rows).toHaveLength(8);
    expect(capped.onlyCurrent.hidden).toBe(2);
  });
});
