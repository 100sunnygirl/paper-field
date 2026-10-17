import type { FieldProviders, FieldSource, FieldSources, Lab, MetaField, OpenSource, PreparedMeta } from "./types";
import { safeHttpUrl } from "./urls";

export interface MergePrev {
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
  fieldSources: FieldSources;
  fieldProviders?: FieldProviders;
  metaRev: number;
  authorCount: number;
}

export interface MergePlan {
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
  fieldSources: FieldSources;
  fieldProviders: FieldProviders;
  replaceAuthors: boolean;
  confidence: number | null;
  /** 本次真正改动的字段（值变了，或来源 / 徽章要改）；写库时只写这些列。 */
  changed: MetaField[];
}

export interface MergeMode {
  /** 确认框里选了「覆盖」：可以替换手动值（请求发出后又改过的除外）。 */
  overwrite: boolean;
  /** 刷新链接：文献库之间可以互相更新。 */
  replaceApi: boolean;
}

/** 标识符只能来自用户或文献库：模型给的 DOI、arXiv、年份一律不写。 */
const IDENTIFIER_FIELDS: ReadonlySet<MetaField> = new Set(["doi", "arxivId", "year"]);

/**
 * 字段来源决策表：现有来源 × 本次写入，决定是否写入。
 *
 * | 现有 ＼ 写入        | 文献库（补全） | 文献库（刷新链接） | 模型（补全） | 模型（用 AI 覆盖） |
 * |--------------------|--------------|------------------|------------|------------------|
 * | 空                  | 写           | 写               | 写          | 写               |
 * | file（文件名标题）    | 写           | 写               | 写          | 写               |
 * | llm                | 写           | 写               | 保留        | 写               |
 * | api                | 保留          | 写               | 保留        | 保留             |
 * | user               | 保留（覆盖时写）| 保留              | 保留        | 仅确认后写         |
 *
 * 另外：模型不写标识符；请求发出后用户又改过的手动值，任何模式都保留（由调用方以
 * `userEditedSince` 传入）。
 */
export function decide(
  field: MetaField,
  prev: FieldSource | undefined,
  hasPrev: boolean,
  incoming: "api" | "llm",
  mode: MergeMode,
  userEditedSince: boolean,
): boolean {
  if (incoming === "llm" && IDENTIFIER_FIELDS.has(field)) return false;
  if (!hasPrev || !prev || prev === "file") return true;
  if (prev === "user") return mode.overwrite && !userEditedSince;
  if (incoming === "api") {
    if (prev === "llm") return true;
    return mode.replaceApi; // api → api：只有刷新链接
  }
  // incoming === "llm"
  if (prev === "api") return false;
  return mode.overwrite; // llm → llm
}

const OPEN: OpenSource[] = ["unknown", "open", "closed", "request"];

function trimmed(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 按决策表合并一次补全结果。值没变时不改来源、不改徽章（文件名标题例外：
 * 文献库确认了同样的值，来源改记文献库）。
 */
export function planPreparedMeta(
  prev: MergePrev,
  meta: PreparedMeta,
  overwrite: boolean,
  source: "api" | "llm",
  startedRev?: number,
  replaceApi = false,
): MergePlan {
  const mode: MergeMode = { overwrite, replaceApi };
  // 请求发出后用户又改过元数据：手动字段一律保留。startedRev 缺省表示不绑定在途请求。
  const userEditedSince = startedRev !== undefined && prev.metaRev > startedRev;
  const sources: FieldSources = { ...prev.fieldSources };
  const providers: FieldProviders = { ...(prev.fieldProviders ?? {}) };
  const incomingProviders = meta.fieldProviders;
  const changed = new Set<MetaField>();

  function stamp(field: MetaField): void {
    sources[field] = source;
    if (source === "api" && incomingProviders?.[field]) providers[field] = incomingProviders[field]!;
    else delete providers[field];
    changed.add(field);
  }

  /** 通用：incoming 为空不写；决策表不许写则保留；值相同只在来源是 file / 缺省时改记来源。 */
  function take<T>(field: MetaField, prevValue: T, nextValue: T | null, hasPrev: boolean, empty: (v: T) => boolean): T {
    if (nextValue === null || empty(nextValue)) return prevValue;
    if (!decide(field, prev.fieldSources[field], hasPrev, source, mode, userEditedSince)) return prevValue;
    if (hasPrev && sameJson(prevValue, nextValue)) {
      const current = prev.fieldSources[field];
      if (current && current !== "file") return prevValue;
    }
    stamp(field);
    return nextValue;
  }

  const str = (field: MetaField, prevValue: string, next: unknown) =>
    take(field, prevValue, trimmed(next) || null, Boolean(prevValue.trim()), (v) => !v);
  const nullable = (field: MetaField, prevValue: string | null, next: unknown) =>
    take<string | null>(field, prevValue, trimmed(next) || null, Boolean(prevValue?.trim()), (v) => !v);
  const url = (field: "pdfUrl" | "codeUrl" | "projectPage", prevValue: string | null, next: unknown) =>
    take<string | null>(field, safeHttpUrl(prevValue), safeHttpUrl(trimmed(next)), Boolean(safeHttpUrl(prevValue)), (v) => !v);

  const yearIncoming = typeof meta.year === "number" && Number.isFinite(meta.year) ? Math.trunc(meta.year) : null;
  const year = take<number | null>("year", prev.year, yearIncoming, prev.year != null, (v) => v == null);

  const tagsIncoming = Array.isArray(meta.tags) ? meta.tags.map(trimmed).filter(Boolean) : [];
  const tags = take<string[]>("tags", prev.tags, tagsIncoming.length ? tagsIncoming : null, prev.tags.length > 0, (v) => !v.length);

  const labsIncoming = Array.isArray(meta.labs)
    ? meta.labs
        .filter((lab) => trimmed(lab?.name))
        .map((lab) => ({ ...lab, name: trimmed(lab.name), institution: trimmed(lab.institution) }))
    : [];
  const labs = take<Lab[]>("labs", prev.labs, labsIncoming.length ? labsIncoming : null, prev.labs.length > 0, (v) => !v.length);

  const open: OpenSource = OPEN.includes(meta.codeOpenSource) ? meta.codeOpenSource : "unknown";
  const codeOpenSource = take<OpenSource>(
    "codeOpenSource",
    prev.codeOpenSource,
    open === "unknown" ? null : open,
    prev.codeOpenSource !== "unknown",
    (v) => v === "unknown",
  );

  const authorsIncoming = Array.isArray(meta.authors) ? meta.authors.filter((author) => trimmed(author?.name)) : [];
  const replaceAuthors =
    authorsIncoming.length > 0 &&
    decide("authors", prev.fieldSources.authors, prev.authorCount > 0, source, mode, userEditedSince);
  if (replaceAuthors) stamp("authors");

  const confidence = typeof meta.confidence === "number" && Number.isFinite(meta.confidence) ? meta.confidence : null;

  const plan = {
    title: str("title", prev.title, meta.title),
    titleZh: nullable("titleZh", prev.titleZh, meta.titleZh),
    abstract: str("abstract", prev.abstract, meta.abstract),
    year,
    venue: nullable("venue", prev.venue, meta.venue),
    doi: nullable("doi", prev.doi, meta.doi),
    arxivId: nullable("arxivId", prev.arxivId, meta.arxivId),
    pdfUrl: url("pdfUrl", prev.pdfUrl, meta.pdfURL),
    codeUrl: url("codeUrl", prev.codeUrl, meta.codeURL),
    codeOpenSource,
    projectPage: url("projectPage", prev.projectPage, meta.projectPage),
    tags,
    labs,
  };
  return {
    ...plan,
    fieldSources: sources,
    fieldProviders: providers,
    replaceAuthors,
    confidence,
    changed: [...changed],
  };
}
