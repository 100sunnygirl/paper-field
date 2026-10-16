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
/** file：导入 PDF 时用文件名充当的标题，文献库与模型都可以替换它。 */
export type FieldSource = "api" | "llm" | "user" | "file";
export type MetaField =
  | "title"
  | "titleZh"
  | "abstract"
  | "year"
  | "venue"
  | "doi"
  | "arxivId"
  | "pdfUrl"
  | "codeUrl"
  | "codeOpenSource"
  | "projectPage"
  | "tags"
  | "labs"
  | "authors";
export type FieldSources = Partial<Record<MetaField, FieldSource>>;
/** Which bibliographic service wrote an api-sourced field. */
export type FieldProviders = Partial<Record<MetaField, string>>;

export const BIBLIO_PROVIDER_LABELS: Record<string, string> = {
  arxiv: "arXiv",
  crossref: "Crossref",
  openalex: "OpenAlex",
  semanticscholar: "Semantic Scholar",
};

export function biblioProviderLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  return BIBLIO_PROVIDER_LABELS[id] ?? id;
}
export type JobType = "prepareMeta" | "draftNotes" | "refreshLinks" | "mineruParse";
export type MineruProviderKind = "local" | "ssh" | "api";
export type MineruStatus = "pending" | "queued" | "submitted" | "parsing" | "done" | "error" | "cancelled";
export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";
export type AppMode = "field" | "archive" | "intake" | "system";

export const NOTE_DISPLAY_ORDER: NoteKind[] = [
  "summary",
  "highlights",
  "weaknesses",
  "implications",
  "remarks",
];

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
  pdfPath: string | null;
  codeUrl: string | null;
  codeOpenSource: OpenSource;
  projectPage: string | null;
  readingStatus: ReadingStatus;
  readAt: string | null;
  llmPreparedAt: string | null;
  notesDraftedByLlm: boolean;
  userNotesTouched: boolean;
  userMetaTouched: boolean;
  fieldSources?: FieldSources;
  fieldProviders?: FieldProviders;
  metaConfidence?: number | null;
  metaRev?: number;
  pdfOriginalPath?: string | null;
  mineruStatus: MineruStatus | null;
  mineruParseId: string | null;
  mineruDocRef: string | null;
  mineruError: string | null;
  mineruParseIds: string[];
  mineruProvider: MineruProviderKind | string | null;
  mineruCredFingerprint: string | null;
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
  parsedMarkdown: string;
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
  paperTitleZh?: string | null;
  domainId?: string;
  domainName?: string;
  domainCode?: string;
}

/** 作业面板用的轻量书目：标题与所属领域。 */
export interface PaperBrief {
  id: string;
  title: string;
  titleZh: string | null;
  domainId: string;
  domainName: string;
  domainCode: string;
}

export interface FieldStats {
  read: number;
  total: number;
  openSource: number;
  queued: number;
  running: number;
}

/** 单个 LLM 提供商的公共视图：密钥永不回显，只返回 hasKey。 */
export interface LlmProviderView {
  id: string;
  /** 命中预设时为预设 id（openai/deepseek/…），自定义为 null。 */
  presetId: string | null;
  label: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  /** 是否已保存 API Key（requiresKey=false 的本地服务可无 Key）。unreadable 时必须为 false。 */
  hasKey: boolean;
  /** present 已保存，absent 未配置，unreadable 密钥文件读失败。 */
  keyState?: "present" | "absent" | "unreadable";
  requiresKey: boolean;
}

/** 轻量用量统计（按 providerId 记账，llm_settings 合并返回）。 */
export interface LlmUsage {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  /** epoch 毫秒；从未使用为 null。 */
  lastUsedAt: number | null;
}

/** LLM 设置 v2 公共视图：providers 顺序即回退顺序；usage 以 providerId 为键。 */
export interface LlmSettings {
  version: 2;
  providers: LlmProviderView[];
  usage: Record<string, LlmUsage>;
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
  /** Per-field bibliographic service when this payload came from lookup. */
  fieldProviders?: FieldProviders;
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
  weaknesses: { zh: "不足", en: "WEAKNESSES" },
  implications: { zh: "启示", en: "IMPLICATIONS" },
};

export const MODE_LABELS: Record<AppMode, { zh: string; en: string; index: string }> = {
  field: { zh: "阅读", en: "FIELD", index: "01" },
  archive: { zh: "归档", en: "ARCHIVE", index: "02" },
  intake: { zh: "入库", en: "INTAKE", index: "03" },
  system: { zh: "设置", en: "SYSTEM", index: "04" },
};

export const READING_STATUS_LABELS: Record<ReadingStatus, string> = {
  unread: "未读",
  reading: "在读",
  read: "已读",
};

export const FIELD_SOURCE_LABELS: Record<FieldSource, string> = {
  api: "数据库",
  llm: "模型",
  user: "手动",
  file: "文件名",
};

export const OPEN_SOURCE_LABELS: Record<OpenSource, string> = {
  open: "开源",
  closed: "闭源",
  request: "需申请",
  unknown: "未知",
};

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  prepareMeta: "补全论文信息",
  draftNotes: "起草阅读笔记",
  refreshLinks: "刷新链接",
  mineruParse: "MinerU 解析",
};

export const MINERU_PROVIDER_LABELS: Record<string, string> = {
  local: "本地 CLI",
  ssh: "SSH 远程",
  api: "官方 API",
};

export const MINERU_STATUS_LABELS: Record<MineruStatus, string> = {
  pending: "待解析",
  queued: "待发送",
  submitted: "已提交",
  parsing: "解析中",
  done: "解析完成",
  error: "解析失败",
  cancelled: "已取消",
};

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: "等待",
  running: "运行中",
  done: "完成",
  error: "失败",
  cancelled: "已取消",
};

export function noteSourceLabel(block: Pick<NoteBlock, "source" | "userEdited">): string {
  if (block.source === "llm") {
    return block.userEdited ? "AI 起草 · 人工修订" : "AI 起草";
  }
  return "手动笔记";
}
