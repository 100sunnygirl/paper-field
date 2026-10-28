import { NOTE_KINDS, type NoteKind, type PaperDetail, type ReadingStatus } from "./types";

export const STAGE_FIELDS = [
  "title",
  "titleZh",
  "authors",
  "abstract",
  "venue",
  "year",
  "doi",
  "arxivId",
  "codeUrl",
  "projectPage",
  "summary",
  "highlights",
  "weaknesses",
  "implications",
  "remarks",
] as const;

export type StageField = (typeof STAGE_FIELDS)[number];

const NOTE_FIELDS = new Set<StageField>(["summary", "highlights", "weaknesses", "implications", "remarks"]);

export interface StageProse {
  title: string;
  titleZh: string;
  authors: string;
  abstract: string;
  venue: string;
  year: string;
  doi: string;
  arxivId: string;
  codeUrl: string;
  projectPage: string;
  notes: Record<NoteKind, string>;
}

export type NotePermit = { readonly [K in NoteKind]: boolean };

export interface ReadingUndo {
  paperId: string;
  status: ReadingStatus;
  readAt: string | null;
}

export interface LibraryTitle {
  id: string;
  label: string;
}

export interface BothTitle {
  id: string;
  label: string;
  backupLabel: string;
  renamed: boolean;
}

export interface TitleBucket<T> {
  rows: T[];
  hidden: number;
}

export interface PartitionedTitles {
  cap: number;
  onlyCurrent: TitleBucket<LibraryTitle>;
  onlyBackup: TitleBucket<LibraryTitle>;
  both: TitleBucket<BothTitle>;
}

export const RESTORE_TITLE_CAP = 8;

export function libraryLabel(title: string, titleZh: string | null | undefined): string {
  const zh = titleZh?.trim();
  if (zh) return zh;
  const en = title.trim();
  return en || "未命名论文";
}

export function noteWriteNeeded(stored: string, submitted: string): boolean {
  return stored !== submitted;
}

export function defaultNotePermit(
  notes: Partial<Record<NoteKind, { userEdited: boolean }>>,
  openDrafts: Partial<Record<NoteKind, string | undefined>>,
): NotePermit {
  const permit = {} as { [K in NoteKind]: boolean };
  for (const kind of NOTE_KINDS) {
    permit[kind] = notes[kind]?.userEdited !== true && openDrafts[kind] === undefined;
  }
  return permit;
}

export function allowEveryNote(): NotePermit {
  const permit = {} as { [K in NoteKind]: boolean };
  for (const kind of NOTE_KINDS) permit[kind] = true;
  return permit;
}

export function readingUndoPlan(undo: Pick<ReadingUndo, "status" | "readAt">): ReadingStatus[] {
  if (undo.status === "reading" && undo.readAt === null) return ["unread", "reading"];
  return [undo.status];
}

export function authorLine(names: readonly string[]): string {
  return names.filter((name) => name.trim()).join(" · ");
}

export function stageProseFrom(paper: PaperDetail): StageProse {
  const notes = {} as Record<NoteKind, string>;
  for (const kind of NOTE_KINDS) notes[kind] = paper.notes[kind]?.content ?? "";
  return {
    title: paper.title,
    titleZh: paper.titleZh ?? "",
    authors: authorLine(paper.authors.map((author) => author.name)),
    abstract: paper.abstract,
    venue: paper.venue ?? "",
    year: paper.year == null ? "" : String(paper.year),
    doi: paper.doi ?? "",
    arxivId: paper.arxivId ?? "",
    codeUrl: paper.codeUrl ?? "",
    projectPage: paper.projectPage ?? "",
    notes,
  };
}

function savedField(paper: PaperDetail, field: StageField): string {
  switch (field) {
    case "title":
      return paper.title;
    case "titleZh":
      return paper.titleZh ?? "";
    case "authors":
      return authorLine(paper.authors.map((author) => author.name));
    case "abstract":
      return paper.abstract;
    case "venue":
      return paper.venue ?? "";
    case "year":
      return paper.year == null ? "" : String(paper.year);
    case "doi":
      return paper.doi ?? "";
    case "arxivId":
      return paper.arxivId ?? "";
    case "codeUrl":
      return paper.codeUrl ?? "";
    case "projectPage":
      return paper.projectPage ?? "";
    default:
      return paper.notes[field]?.content ?? "";
  }
}

function proseField(prose: StageProse, field: StageField): string {
  switch (field) {
    case "title":
      return prose.title;
    case "titleZh":
      return prose.titleZh;
    case "authors":
      return prose.authors;
    case "abstract":
      return prose.abstract;
    case "venue":
      return prose.venue;
    case "year":
      return prose.year;
    case "doi":
      return prose.doi;
    case "arxivId":
      return prose.arxivId;
    case "codeUrl":
      return prose.codeUrl;
    case "projectPage":
      return prose.projectPage;
    default:
      return prose.notes[field];
  }
}

export function diffStage(prose: StageProse, paper: PaperDetail): StageField[] {
  return STAGE_FIELDS.filter((field) => proseField(prose, field) !== savedField(paper, field));
}

export function adoptProse(prose: StageProse, paper: PaperDetail, fields: readonly StageField[]): StageProse {
  const next: StageProse = { ...prose, notes: { ...prose.notes } };
  for (const field of fields) {
    if (NOTE_FIELDS.has(field)) next.notes[field as NoteKind] = paper.notes[field as NoteKind]?.content ?? "";
    else if (field === "title") next.title = paper.title;
    else if (field === "titleZh") next.titleZh = paper.titleZh ?? "";
    else if (field === "authors") next.authors = authorLine(paper.authors.map((author) => author.name));
    else if (field === "abstract") next.abstract = paper.abstract;
    else if (field === "venue") next.venue = paper.venue ?? "";
    else if (field === "year") next.year = paper.year == null ? "" : String(paper.year);
    else if (field === "doi") next.doi = paper.doi ?? "";
    else if (field === "arxivId") next.arxivId = paper.arxivId ?? "";
    else if (field === "codeUrl") next.codeUrl = paper.codeUrl ?? "";
    else if (field === "projectPage") next.projectPage = paper.projectPage ?? "";
  }
  return next;
}

const PATCH_FIELDS: StageField[] = ["title", "titleZh", "abstract", "venue", "year", "doi", "arxivId", "codeUrl", "projectPage"];

export function stageFieldsInPatch(patch: object): StageField[] {
  const record = patch as Record<string, unknown>;
  return PATCH_FIELDS.filter((key) => record[key] !== undefined);
}

function indexTitles(rows: readonly LibraryTitle[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (!row.id || map.has(row.id)) continue;
    map.set(row.id, row.label);
  }
  return map;
}

function capBucket<T>(rows: T[], cap: number): TitleBucket<T> {
  if (cap <= 0) return { rows: [], hidden: rows.length };
  return { rows: rows.slice(0, cap), hidden: Math.max(0, rows.length - cap) };
}

export function partitionTitles(
  current: readonly LibraryTitle[],
  backup: readonly LibraryTitle[],
  cap: number,
): PartitionedTitles {
  const cur = indexTitles(current);
  const bak = indexTitles(backup);
  const onlyCurrent: LibraryTitle[] = [];
  const onlyBackup: LibraryTitle[] = [];
  const both: BothTitle[] = [];
  for (const [id, label] of cur) {
    const other = bak.get(id);
    if (other === undefined) onlyCurrent.push({ id, label });
    else both.push({ id, label, backupLabel: other, renamed: other !== label });
  }
  for (const [id, label] of bak) {
    if (!cur.has(id)) onlyBackup.push({ id, label });
  }
  const byLabel = (a: { label: string; id: string }, b: { label: string; id: string }) =>
    a.label.localeCompare(b.label, "zh") || a.id.localeCompare(b.id);
  onlyCurrent.sort(byLabel);
  onlyBackup.sort(byLabel);
  both.sort(byLabel);
  return {
    cap,
    onlyCurrent: capBucket(onlyCurrent, cap),
    onlyBackup: capBucket(onlyBackup, cap),
    both: capBucket(both, cap),
  };
}
