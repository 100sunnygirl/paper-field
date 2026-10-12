import type { FieldProviders, FieldSource, FieldSources, Lab, OpenSource, PreparedMeta } from "./types";
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
function protectedUser(source: FieldSource | undefined, metaRev: number, startedRev: number | undefined, overwrite: boolean): boolean {
  if (source !== "user") return false;
  if (!overwrite) return true;
  if (startedRev === undefined) return false;
  return metaRev > startedRev;
}

/**
 * api replaces llm. api does not replace api unless this is a re-lookup or an
 * explicit overwrite. user stays protected. Unset fields (filename titles) may be filled.
 */
function keepPrevious(
  prevSource: FieldSource | undefined,
  hasPrev: boolean,
  overwrite: boolean,
  incoming: FieldSource,
  replaceApi: boolean,
): boolean {
  if (!hasPrev || !prevSource) return false;
  if (prevSource === "llm" && incoming === "api") return false;
  if (prevSource === "api" && incoming === "api") return !(overwrite || replaceApi);
  if (prevSource === "user" || prevSource === "api" || prevSource === "llm") return !overwrite;
  return false;
}

function stamp(
  field: keyof FieldSources,
  source: FieldSource,
  providers: FieldProviders,
  incoming: FieldProviders | undefined,
): void {
  if (source === "api") {
    const name = incoming?.[field];
    if (name) providers[field] = name;
    return;
  }
  delete providers[field];
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
  replaceApi: boolean,
  sources: FieldSources,
  providers: FieldProviders,
  incomingProviders: FieldProviders | undefined,
): string {
  const incoming = next?.trim() ? next.trim() : "";
  const hasPrev = nonEmpty(prev);
  if (!incoming) return prev;
  if (protectedUser(prevSources[field], metaRev, startedRev, overwrite)) return prev;
  if (keepPrevious(prevSources[field], hasPrev, overwrite, source, replaceApi)) return prev;
  sources[field] = source;
  stamp(field, source, providers, incomingProviders);
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
  replaceApi: boolean,
  sources: FieldSources,
  providers: FieldProviders,
  incomingProviders: FieldProviders | undefined,
): string | null {
  const incoming = next?.trim() ? next.trim() : "";
  const hasPrev = nonEmpty(prev);
  if (!incoming) return hasPrev ? prev : null;
  if (protectedUser(prevSources[field], metaRev, startedRev, overwrite)) return prev;
  if (keepPrevious(prevSources[field], hasPrev, overwrite, source, replaceApi)) return prev;
  sources[field] = source;
  stamp(field, source, providers, incomingProviders);
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
  replaceApi: boolean,
  sources: FieldSources,
  providers: FieldProviders,
  incomingProviders: FieldProviders | undefined,
): string | null {
  const kept = takeNullable(
    field,
    safeHttpUrl(prev),
    safeHttpUrl(next),
    prevSources,
    metaRev,
    startedRev,
    overwrite,
    source,
    replaceApi,
    sources,
    providers,
    incomingProviders,
  );
  return safeHttpUrl(kept);
}

/**
 * Fill-empty-only unless `overwrite` is the explicit confirm-dialog choice.
 * api results replace llm-sourced values. User-owned fields edited during the
 * request stay put either way. `replaceApi` is the 刷新链接 re-lookup.
 */
export function planPreparedMeta(
  prev: MergePrev,
  meta: PreparedMeta,
  overwrite: boolean,
  source: FieldSource,
  startedRev?: number,
  replaceApi = false,
): MergePlan {
  const sources: FieldSources = { ...prev.fieldSources };
  const providers: FieldProviders = { ...(prev.fieldProviders ?? {}) };
  const incomingProviders = meta.fieldProviders;
  const open: OpenSource = OPEN.includes(meta.codeOpenSource) ? meta.codeOpenSource : "unknown";
  const yearIncoming = typeof meta.year === "number" && Number.isFinite(meta.year) ? meta.year : null;
  let year = prev.year;
  if (
    yearIncoming != null &&
    !protectedUser(prev.fieldSources.year, prev.metaRev, startedRev, overwrite) &&
    !keepPrevious(prev.fieldSources.year, prev.year != null, overwrite, source, replaceApi)
  ) {
    year = yearIncoming;
    sources.year = source;
    stamp("year", source, providers, incomingProviders);
  }

  const tagsIncoming = Array.isArray(meta.tags) ? meta.tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
  let tags = prev.tags;
  if (
    tagsIncoming.length &&
    !protectedUser(prev.fieldSources.tags, prev.metaRev, startedRev, overwrite) &&
    !keepPrevious(prev.fieldSources.tags, prev.tags.length > 0, overwrite, source, replaceApi)
  ) {
    tags = tagsIncoming;
    sources.tags = source;
    stamp("tags", source, providers, incomingProviders);
  }

  const labsIncoming = Array.isArray(meta.labs) ? meta.labs.filter((lab) => lab?.name?.trim()) : [];
  let labs = prev.labs;
  if (
    labsIncoming.length &&
    !protectedUser(prev.fieldSources.labs, prev.metaRev, startedRev, overwrite) &&
    !keepPrevious(prev.fieldSources.labs, prev.labs.length > 0, overwrite, source, replaceApi)
  ) {
    labs = labsIncoming;
    sources.labs = source;
    stamp("labs", source, providers, incomingProviders);
  }

  let codeOpenSource = prev.codeOpenSource;
  if (
    open !== "unknown" &&
    !protectedUser(prev.fieldSources.codeOpenSource, prev.metaRev, startedRev, overwrite) &&
    !keepPrevious(prev.fieldSources.codeOpenSource, prev.codeOpenSource !== "unknown", overwrite, source, replaceApi)
  ) {
    codeOpenSource = open;
    sources.codeOpenSource = source;
    stamp("codeOpenSource", source, providers, incomingProviders);
  }

  const authorsIncoming = Array.isArray(meta.authors) ? meta.authors.filter((author) => author?.name?.trim()) : [];
  const replaceAuthorsFlag =
    authorsIncoming.length > 0 &&
    !protectedUser(prev.fieldSources.authors, prev.metaRev, startedRev, overwrite) &&
    !keepPrevious(prev.fieldSources.authors, prev.authorCount > 0, overwrite, source, replaceApi);
  if (replaceAuthorsFlag) {
    sources.authors = source;
    stamp("authors", source, providers, incomingProviders);
  }

  const confidence = typeof meta.confidence === "number" && Number.isFinite(meta.confidence) ? meta.confidence : null;
  const args = [prev.fieldSources, prev.metaRev, startedRev, overwrite, source, replaceApi, sources, providers, incomingProviders] as const;

  return {
    title: takeString("title", prev.title, meta.title, ...args),
    titleZh: takeNullable("titleZh", prev.titleZh, meta.titleZh, ...args),
    abstract: takeString("abstract", prev.abstract, meta.abstract, ...args),
    year,
    venue: takeNullable("venue", prev.venue, meta.venue, ...args),
    doi: takeNullable("doi", prev.doi, meta.doi, ...args),
    arxivId: takeNullable("arxivId", prev.arxivId, meta.arxivId, ...args),
    pdfUrl: takeUrl("pdfUrl", prev.pdfUrl, meta.pdfURL, ...args),
    codeUrl: takeUrl("codeUrl", prev.codeUrl, meta.codeURL, ...args),
    codeOpenSource,
    projectPage: takeUrl("projectPage", prev.projectPage, meta.projectPage, ...args),
    tags,
    labs,
    fieldSources: sources,
    fieldProviders: providers,
    replaceAuthors: replaceAuthorsFlag,
    confidence,
  };
}
