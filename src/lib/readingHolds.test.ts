import { describe, expect, it } from "vitest";
import { NOTE_KINDS } from "./types";
import {
  blankCite,
  defaultNotePermit,
  diffStage,
  draftPaperCount,
  libraryLabel,
  noteProposals,
  noteWriteNeeded,
  partitionTitles,
  readingUndoPlan,
  restoreRowLabel,
  stageProseFrom,
  titleIsFile,
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
        { id: "a", label: "只在当前", year: "2020", venue: "CVPR" },
        { id: "b", label: "旧名", year: "", venue: "NeurIPS" },
        { id: "a", label: "重复忽略", year: "1999", venue: "忽略" },
      ],
      [
        { id: "b", label: "新名", year: "2024", venue: "ICML" },
        { id: "c", label: "只在备份", year: "", venue: "" },
        { id: "", label: "空", year: "1", venue: "x" },
      ],
      8,
    );
    expect(diff.cap).toBe(8);
    expect(diff.onlyCurrent.rows).toEqual([{ id: "a", label: "只在当前", year: "2020", venue: "CVPR" }]);
    expect(diff.onlyBackup.rows).toEqual([{ id: "c", label: "只在备份", year: "", venue: "" }]);
    expect(diff.both.rows).toEqual([
      { id: "b", label: "旧名", backupLabel: "新名", renamed: true, year: "", venue: "NeurIPS" },
    ]);

    const capped = partitionTitles(
      Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, label: `文${i}`, year: "", venue: "" })),
      [],
      8,
    );
    expect(capped.onlyCurrent.rows).toHaveLength(8);
    expect(capped.onlyCurrent.hidden).toBe(2);
    expect(capped.onlyBackup.rows).toHaveLength(0);
    expect(capped.both.rows).toHaveLength(0);
  });

  it("treats a filename title as the only file-sourced title", () => {
    expect(titleIsFile({ title: "file" })).toBe(true);
    expect(titleIsFile({ title: "user" })).toBe(false);
    expect(titleIsFile(undefined)).toBe(false);
    expect(titleIsFile(null)).toBe(false);
  });

  it("counts papers that still have a draft, including an empty string", () => {
    expect(draftPaperCount({})).toBe(0);
    expect(draftPaperCount({ a: {}, b: undefined })).toBe(0);
    expect(draftPaperCount({ a: { summary: "" }, b: { highlights: "x" }, c: {} })).toBe(2);
  });

  it("keeps permitted note proposals and leaves drafts and edits out", () => {
    const permit = { ...defaultNotePermit({}, {}), summary: false };
    const notes = {
      summary: { content: "旧总结", userEdited: false, rev: 3 },
      highlights: { content: "亮", userEdited: true, rev: 1 },
      remarks: { content: "", userEdited: false, rev: -1 },
    };
    const proposals = noteProposals(permit, notes, { weaknesses: "" }, {
      summary: "新总结",
      highlights: "新亮点",
      weaknesses: "新不足",
      implications: "新启示",
      remarks: "新备注",
    });
    expect(proposals).toEqual([{ kind: "implications", rev: 0, before: "", after: "新启示" }]);
  });

  it("joins a citation only from non-blank venue and year", () => {
    expect(blankCite("", null)).toBe("");
    expect(blankCite("  ", "  ")).toBe("");
    expect(blankCite("NeurIPS", null)).toBe("NeurIPS");
    expect(blankCite(null, 2024)).toBe("2024");
    expect(blankCite("NeurIPS", "2024")).toBe("NeurIPS · 2024");
  });

  it("prints a restore row as title, venue, and year, and keeps a rename", () => {
    expect(restoreRowLabel({ label: "标题", venue: "", year: "" })).toBe("标题");
    expect(restoreRowLabel({ label: "标题", venue: "CVPR", year: "2020" })).toBe("标题 · CVPR · 2020");
    expect(restoreRowLabel({ label: "标题", venue: "", year: "2020" })).toBe("标题 · 2020");
    expect(
      restoreRowLabel({ label: "旧名", backupLabel: "新名", renamed: true, venue: "NeurIPS", year: "2020" }),
    ).toBe("旧名 · NeurIPS · 2020 → 新名");
    expect(restoreRowLabel({ label: "旧名", backupLabel: "新名", renamed: true, venue: "", year: "" })).toBe(
      "旧名 → 新名",
    );
  });
});
