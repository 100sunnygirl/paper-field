export const NOTE_KINDS = [
  "remarks",
  "summary",
  "highlights",
  "weaknesses",
  "implications",
] as const;

export type NoteKind = (typeof NOTE_KINDS)[number];
export type ReadingStatus = "unread" | "reading" | "read";
export type OpenSource = "unknown" | "open" | "closed" | "request";
export type NoteSource = "manual" | "llm";
export type JobType = "prepareMeta" | "draftNotes" | "refreshLinks";
export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";
export type AppMode = "field" | "archive" | "intake" | "system";

export interface Domain {
  id: string;
  name: string;
  code: string;
  summary: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface Lab {
  name: string;
  institution: string;
}

export interface Author {
  id: string;
  name: string;
  nameZh: string | null;
  affiliation: string | null;
  lab: string | null;
  homepage: string | null;
  orcid: string | null;
  order: number;
  isCorresponding: boolean;
}

export interface NoteBlock {
  id: string;
  paperId: string;
  kind: NoteKind;
  content: string;
  source: NoteSource;
  userEdited: boolean;
  revisedAt: string | null;
}

export interface Paper {
  id: string;
  domainId: string;
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
  readingStatus: ReadingStatus;
  readAt: string | null;
  llmPreparedAt: string | null;
  notesDraftedByLlm: boolean;
  userNotesTouched: boolean;
  tags: string[];
  labs: Lab[];
  createdAt: string;
  updatedAt: string;
}

export interface PaperListItem extends Paper {
  firstAuthor: string | null;
  authorCount: number;
  domainName: string;
  domainCode: string;
}

export interface PaperDetail extends Paper {
  authors: Author[];
  notes: Record<NoteKind, NoteBlock>;
  domain: Domain;
}

export interface LlmJob {
  id: string;
  paperId: string;
  type: JobType;
  status: JobStatus;
  prompt: string | null;
  resultJson: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  paperTitle?: string;
  domainName?: string;
}

export interface FieldStats {
  read: number;
  total: number;
  openSource: number;
  queued: number;
  running: number;
}

export interface LlmSettings {
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

export interface PreparedMeta {
  title: string;
  titleZh: string | null;
  abstract: string;
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  authors: Array<{
    name: string;
    affiliation?: string | null;
    lab?: string | null;
    isCorresponding?: boolean;
  }>;
  labs: Lab[];
  codeOpenSource: OpenSource;
  codeURL: string | null;
  projectPage: string | null;
  pdfURL: string | null;
  tags: string[];
  confidence?: number;
}

export interface DraftedNotes {
  remarks: string;
  summary: string;
  highlights: string;
  weaknesses: string;
  implications: string;
}

export const NOTE_LABELS: Record<NoteKind, { zh: string; en: string }> = {
  remarks: { zh: "备注", en: "REMARKS" },
  summary: { zh: "总结", en: "SUMMARY" },
  highlights: { zh: "亮点", en: "HIGHLIGHTS" },
  weaknesses: { zh: "缺点", en: "WEAKNESSES" },
  implications: { zh: "启示", en: "IMPLICATIONS" },
};

export const MODE_LABELS: Record<AppMode, { zh: string; en: string; index: string }> = {
  field: { zh: "现场", en: "FIELD", index: "01" },
  archive: { zh: "归档", en: "ARCHIVE", index: "02" },
  intake: { zh: "入库", en: "INTAKE", index: "03" },
  system: { zh: "系统", en: "SYSTEM", index: "04" },
};
