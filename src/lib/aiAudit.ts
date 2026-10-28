/**
 * AI 写入的审计与挽回：覆盖前快照、变更（diff）计算、撤销与会话内笔记版本。
 *
 * 诚实边界：快照与版本只保存在内存里（本次会话），重启后清空；
 * 不写数据库表（持久化历史需要后续 schema 支持）。撤销沿用人工修改保护语义：
 * AI 写入之后用户又改过的字段 / 笔记块不会被撤销覆盖，只在通知里说明保留。
 */
import type { Author, Lab, MetaField, NoteKind, NoteSource, OpenSource, PaperDetail } from "./types";
import { NOTE_KINDS } from "./types";

/** 快照覆盖的著录字段（authors 单独存名单）。 */
export const META_SNAPSHOT_FIELDS = [
  "title",
  "titleZh",
  "abstract",
  "year",
  "venue",
  "doi",
  "arxivId",
  "pdfUrl",
  "codeUrl",
  "codeOpenSource",
  "projectPage",
  "tags",
  "labs",
] as const satisfies readonly MetaField[];

export interface MetaSnapshot {
  title: string;
  titleZh: string | null;
  abstract: string;
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  pdfUrl: string | null;
  codeUrl: string | null;
  codeOpenSource: OpenSource;
  projectPage: string | null;
  tags: string[];
  labs: Lab[];
  authors: Author[];
}

export function snapshotMeta(paper: PaperDetail): MetaSnapshot {
  return {
    title: paper.title,
    titleZh: paper.titleZh,
    abstract: paper.abstract,
    year: paper.year,
    venue: paper.venue,
    doi: paper.doi,
    arxivId: paper.arxivId,
    pdfUrl: paper.pdfUrl,
    codeUrl: paper.codeUrl,
    codeOpenSource: paper.codeOpenSource,
    projectPage: paper.projectPage,
    tags: paper.tags,
    labs: paper.labs,
    authors: paper.authors,
  };
}

/** 一块笔记在写入前的样子（含来源，供版本列表展示）。 */
export interface NoteSnapshot {
  content: string;
  source: NoteSource;
  userEdited: boolean;
}

export function snapshotNotes(paper: PaperDetail): Record<NoteKind, NoteSnapshot> {
  return Object.fromEntries(
    NOTE_KINDS.map((kind) => [
      kind,
      {
        content: paper.notes[kind]?.content ?? "",
        source: paper.notes[kind]?.source ?? "manual",
        userEdited: Boolean(paper.notes[kind]?.userEdited),
      },
    ]),
  ) as Record<NoteKind, NoteSnapshot>;
}

export interface MetaChange {
  field: MetaField;
  from: string;
  to: string;
}

export interface NoteChange {
  kind: NoteKind;
  from: string;
  to: string;
}

/** 一次 AI 写入的完整记录：写入前后的快照 + 计算好的变更清单。 */
export interface AiWriteRecord {
  id: number;
  paperId: string;
  paperTitle: string;
  /** epoch 毫秒。 */
  at: number;
  kind: "meta" | "notes";
  /** 补全论文信息（prepareMeta / refreshLinks）时的前后快照。 */
  meta?: { before: MetaSnapshot; after: MetaSnapshot; changes: MetaChange[] };
  /** 起草笔记时的前后快照。 */
  notes?: { before: Record<NoteKind, NoteSnapshot>; after: Record<NoteKind, NoteSnapshot>; changes: NoteChange[] };
}

/** 值的显示文本（diff 行与撤销清单共用；过长的截断由调用方决定）。 */
export function metaValueText(field: MetaField, value: unknown): string {
  if (value == null) return "";
  if (field === "tags" || field === "labs") {
    const list = Array.isArray(value) ? value : [];
    return field === "tags" ? list.join("、") : list.map((lab) => (lab as Lab).name).filter(Boolean).join("、");
  }
  if (field === "authors") {
    const list = Array.isArray(value) ? value : [];
    return list.map((author) => (author as Author).name).filter(Boolean).join("、");
  }
  return String(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** 逐字段比较两次快照，产出「旧值 → 新值」清单（值没变的不列）。 */
export function diffMeta(before: MetaSnapshot, after: MetaSnapshot): MetaChange[] {
  const changes: MetaChange[] = [];
  for (const field of META_SNAPSHOT_FIELDS) {
    if (!sameValue(before[field], after[field])) {
      changes.push({ field, from: metaValueText(field, before[field]), to: metaValueText(field, after[field]) });
    }
  }
  if (!sameValue(before.authors, after.authors)) {
    changes.push({ field: "authors", from: metaValueText("authors", before.authors), to: metaValueText("authors", after.authors) });
  }
  return changes;
}

/** 逐块比较两次笔记快照（内容没变的块不列）。 */
export function diffNotes(before: Record<NoteKind, NoteSnapshot>, after: Record<NoteKind, NoteSnapshot>): NoteChange[] {
  return NOTE_KINDS.filter((kind) => before[kind].content !== after[kind].content).map((kind) => ({
    kind,
    from: before[kind].content,
    to: after[kind].content,
  }));
}

/** 会话内记录上限：够回看最近的补全 / 起草，又不无限占用内存。 */
const MAX_RECORDS = 20;
/** 每块笔记保留的版本数上限（AI 写入 + 手动保存都记版本）。 */
const MAX_VERSIONS_PER_BLOCK = 12;

const records: AiWriteRecord[] = [];
let nextRecordId = 1;

/** 记一次 AI 写入（最新的排在最前）；超出上限丢最旧的。 */
export function recordAiWrite(input: Omit<AiWriteRecord, "id" | "at">): AiWriteRecord {
  const record: AiWriteRecord = { ...input, id: nextRecordId++, at: Date.now() };
  records.unshift(record);
  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
  return record;
}

export function aiWriteRecords(): AiWriteRecord[] {
  return [...records];
}

export function latestAiWrite(paperId: string): AiWriteRecord | null {
  return records.find((record) => record.paperId === paperId) ?? null;
}

export function findAiWrite(id: number): AiWriteRecord | null {
  return records.find((record) => record.id === id) ?? null;
}

export function dismissAiWrite(id: number): void {
  const index = records.findIndex((record) => record.id === id);
  if (index >= 0) records.splice(index, 1);
}

/** 一块笔记的一个历史版本。 */
export interface NoteVersion {
  at: number;
  by: "ai" | "user";
  content: string;
}

const versions = new Map<string, NoteVersion[]>();

function versionKey(paperId: string, kind: NoteKind): string {
  return `${paperId}::${kind}`;
}

/** 记一个版本（AI 写入与手动保存都记）；同内容连续重复不重复记。 */
export function pushNoteVersion(paperId: string, kind: NoteKind, by: "ai" | "user", content: string): void {
  const key = versionKey(paperId, kind);
  const list = versions.get(key) ?? [];
  const top = list[0];
  if (top && top.by === by && top.content === content) return;
  list.unshift({ at: Date.now(), by, content });
  if (list.length > MAX_VERSIONS_PER_BLOCK) list.length = MAX_VERSIONS_PER_BLOCK;
  versions.set(key, list);
}

export function noteVersions(paperId: string, kind: NoteKind): NoteVersion[] {
  return [...(versions.get(versionKey(paperId, kind)) ?? [])];
}

/** 撤销后清掉该论文该块的版本里那条 AI 版本吗？不：版本保留（用户可能想再恢复回来）。 */
export function clearNoteVersions(paperId: string): void {
  for (const key of [...versions.keys()]) {
    if (key.startsWith(`${paperId}::`)) versions.delete(key);
  }
}
