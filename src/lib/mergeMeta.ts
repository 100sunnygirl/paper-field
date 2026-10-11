import type { FieldSource, FieldSources, Lab, OpenSource, PreparedMeta } from "./types";
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
  replaceAuthors: boolean;
  confidence: number | null;
}

const OPEN: OpenSource[] = ["unknown", "open", "closed", "request"];

function nonEmpty(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

/**
 * A user-owned field edited after the job started is never replaced.
 * `startedRev === undefined` means this call is not tied to an in-flight job,
 * so an explicit overwrite may replace user-owned fields.
 */
function owned(source: FieldSource | undefined): boolean {
  return source === "user" || source === "api" || source === "llm";
}

function protectedUser(source: FieldSource | undefined, metaRev: number, startedRev: number | undefined, overwrite: boolean): boolean {
  if (source !== "user") return false;
  if (!overwrite) return true;
  if (startedRev === undefined) return false;
  return metaRev > startedRev;
}

/** Keep a non-empty owned value unless this call is an explicit overwrite. Unset fields (filename titles) may be filled. */
function keepOwned(source: FieldSource | undefined, hasPrev: boolean, overwrite: boolean): boolean {
  return !overwrite && hasPrev && owned(source);
}

function takeString(
  field: keyof FieldSources,
  prev: string,
  next: string | null | undefined,
  prevSources: FieldSources,
  metaRev: number,
  startedRev: number | undefined,
  overwrite: boolean,
  source: FieldSource,
  sources: FieldSources,
): string {
  const incoming = next?.trim() ? next.trim() : "";
  const hasPrev = nonEmpty(prev);
  if (!incoming) return prev;
  if (protectedUser(prevSources[field], metaRev, startedRev, overwrite)) return prev;
  if (keepOwned(prevSources[field], hasPrev, overwrite)) return prev;
  sources[field] = source;
  return incoming;
}

function takeNullable(
  field: keyof FieldSources,
  prev: string | null,
  next: string | null | undefined,
  prevSources: FieldSources,
  metaRev: number,
  startedRev: number | undefined,
  overwrite: boolean,
  source: FieldSource,
  sources: FieldSources,
): string | null {
  const incoming = next?.trim() ? next.trim() : "";
  const hasPrev = nonEmpty(prev);
  if (!incoming) return hasPrev ? prev : null;
  if (protectedUser(prevSources[field], metaRev, startedRev, overwrite)) return prev;
  if (keepOwned(prevSources[field], hasPrev, overwrite)) return prev;
  sources[field] = source;
  return incoming;
}

function takeUrl(
  field: "pdfUrl" | "codeUrl" | "projectPage",
  prev: string | null,
  next: string | null | undefined,
  prevSources: FieldSources,
  metaRev: number,
  startedRev: number | undefined,
  overwrite: boolean,
  source: FieldSource,
  sources: FieldSources,
): string | null {
  const kept = takeNullable(field, safeHttpUrl(prev), safeHttpUrl(next), prevSources, metaRev, startedRev, overwrite, source, sources);
  return safeHttpUrl(kept);
}

/**
 * Fill-empty-only unless `overwrite` is the explicit confirm-dialog choice.
 * User-owned fields whose revision moved during the request stay put either way.
 */
export function planPreparedMeta(
  prev: MergePrev,
  meta: PreparedMeta,
  overwrite: boolean,
  source: FieldSource,
  startedRev?: number,
): MergePlan {
  const sources: FieldSources = { ...prev.fieldSources };
  const open: OpenSource = OPEN.includes(meta.codeOpenSource) ? meta.codeOpenSource : "unknown";
  const yearIncoming = typeof meta.year === "number" && Number.isFinite(meta.year) ? meta.year : null;
  let year = prev.year;
  if (
    yearIncoming != null &&
    !protectedUser(prev.fieldSources.year, prev.metaRev, startedRev, overwrite) &&
    !keepOwned(prev.fieldSources.year, prev.year != null, overwrite)
  ) {
    year = yearIncoming;
    sources.year = source;
  }

  const tagsIncoming = Array.isArray(meta.tags) ? meta.tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
  let tags = prev.tags;
  if (
    tagsIncoming.length &&
    !protectedUser(prev.fieldSources.tags, prev.metaRev, startedRev, overwrite) &&
    !keepOwned(prev.fieldSources.tags, prev.tags.length > 0, overwrite)
  ) {
    tags = tagsIncoming;
    sources.tags = source;
  }

  const labsIncoming = Array.isArray(meta.labs) ? meta.labs.filter((lab) => lab?.name?.trim()) : [];
  let labs = prev.labs;
  if (
    labsIncoming.length &&
    !protectedUser(prev.fieldSources.labs, prev.metaRev, startedRev, overwrite) &&
    !keepOwned(prev.fieldSources.labs, prev.labs.length > 0, overwrite)
  ) {
    labs = labsIncoming;
    sources.labs = source;
  }

  let codeOpenSource = prev.codeOpenSource;
  if (
    open !== "unknown" &&
    !protectedUser(prev.fieldSources.codeOpenSource, prev.metaRev, startedRev, overwrite) &&
    !keepOwned(prev.fieldSources.codeOpenSource, prev.codeOpenSource !== "unknown", overwrite)
  ) {
    codeOpenSource = open;
    sources.codeOpenSource = source;
  }

  const authorsIncoming = Array.isArray(meta.authors) ? meta.authors.filter((author) => author?.name?.trim()) : [];
  const replaceAuthors =
    authorsIncoming.length > 0 &&
    !protectedUser(prev.fieldSources.authors, prev.metaRev, startedRev, overwrite) &&
    !keepOwned(prev.fieldSources.authors, prev.authorCount > 0, overwrite);
  if (replaceAuthors) sources.authors = source;

  const confidence = typeof meta.confidence === "number" && Number.isFinite(meta.confidence) ? meta.confidence : null;

  return {
    title: takeString("title", prev.title, meta.title, prev.fieldSources, prev.metaRev, startedRev, overwrite, source, sources),
    titleZh: takeNullable("titleZh", prev.titleZh, meta.titleZh, prev.fieldSources, prev.metaRev, startedRev, overwrite, source, sources),
    abstract: takeString("abstract", prev.abstract, meta.abstract, prev.fieldSources, prev.metaRev, startedRev, overwrite, source, sources),
    year,
    venue: takeNullable("venue", prev.venue, meta.venue, prev.fieldSources, prev.metaRev, startedRev, overwrite, source, sources),
    doi: takeNullable("doi", prev.doi, meta.doi, prev.fieldSources, prev.metaRev, startedRev, overwrite, source, sources),
    arxivId: takeNullable("arxivId", prev.arxivId, meta.arxivId, prev.fieldSources, prev.metaRev, startedRev, overwrite, source, sources),
    pdfUrl: takeUrl("pdfUrl", prev.pdfUrl, meta.pdfURL, prev.fieldSources, prev.metaRev, startedRev, overwrite, source, sources),
    codeUrl: takeUrl("codeUrl", prev.codeUrl, meta.codeURL, prev.fieldSources, prev.metaRev, startedRev, overwrite, source, sources),
    codeOpenSource,
    projectPage: takeUrl("projectPage", prev.projectPage, meta.projectPage, prev.fieldSources, prev.metaRev, startedRev, overwrite, source, sources),
    tags,
    labs,
    fieldSources: sources,
    replaceAuthors,
    confidence,
  };
}
