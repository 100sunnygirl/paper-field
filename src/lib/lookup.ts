import { log } from "./logger";
import type { FieldProviders, FieldSource, FieldSources, PaperDetail, PreparedMeta } from "./types";
import { isTauri } from "./util";
import { safeHttpUrl } from "./urls";

interface LookupAuthor {
  name: string;
  affiliation?: string | null;
}

interface LookupHit {
  title: string;
  abstract?: string | null;
  year?: number | null;
  venue?: string | null;
  doi?: string | null;
  arxivId?: string | null;
  pdfUrl?: string | null;
  authors?: LookupAuthor[];
  confidence?: number | null;
  providers?: FieldProviders;
}

export interface LookupNotice {
  source: string;
  code: string;
  message: string;
}

export interface LookupResult {
  meta: PreparedMeta | null;
  notices: LookupNotice[];
  openalexRemainingUsd: number | null;
  openalexLimitUsd: number | null;
}

const EMPTY_LOOKUP: LookupResult = {
  meta: null,
  notices: [],
  openalexRemainingUsd: null,
  openalexLimitUsd: null,
};

function asNotices(value: unknown): LookupNotice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const notice = item as Partial<LookupNotice>;
    if (!notice.message) return [];
    return [{ source: notice.source ?? "", code: notice.code ?? "", message: notice.message }];
  });
}

export async function lookupPaper(paper: Pick<PaperDetail, "title" | "arxivId" | "doi">): Promise<LookupResult> {
  if (!isTauri()) return EMPTY_LOOKUP;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const outcome = await invoke<{
      hit?: LookupHit | null;
      notices?: LookupNotice[];
      openalexRemainingUsd?: number | null;
      openalexLimitUsd?: number | null;
    }>("lookup_paper", {
      arxivId: paper.arxivId,
      doi: paper.doi,
      title: paper.title,
    });
    const hit = outcome?.hit;
    const meta = hit?.title?.trim()
      ? {
          title: hit.title.trim(),
          titleZh: null,
          abstract: hit.abstract?.trim() ?? "",
          year: typeof hit.year === "number" ? hit.year : null,
          venue: hit.venue?.trim() || null,
          doi: hit.doi?.trim() || null,
          arxivId: hit.arxivId?.trim() || null,
          authors: Array.isArray(hit.authors) ? hit.authors.filter((author) => author?.name?.trim()) : [],
          labs: [],
          codeOpenSource: "unknown" as const,
          codeURL: null,
          projectPage: null,
          pdfURL: safeHttpUrl(hit.pdfUrl),
          tags: [],
          confidence: typeof hit.confidence === "number" ? hit.confidence : undefined,
          fieldProviders: hit.providers ?? {},
        }
      : null;
    return {
      meta,
      notices: asNotices(outcome?.notices),
      openalexRemainingUsd: typeof outcome?.openalexRemainingUsd === "number" ? outcome.openalexRemainingUsd : null,
      openalexLimitUsd: typeof outcome?.openalexLimitUsd === "number" ? outcome.openalexLimitUsd : null,
    };
  } catch (err) {
    log.warn("llm", "文献库查询失败，已跳过", err instanceof Error ? err.message : String(err));
    return EMPTY_LOOKUP;
  }
}

export async function verifyReachable(url: string): Promise<boolean> {
  const safe = safeHttpUrl(url);
  if (!safe) return false;
  if (!isTauri()) return true;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("verify_url", { url: safe });
  } catch (err) {
    log.warn("llm", "链接校验失败，已丢弃", err instanceof Error ? err.message : String(err));
    return false;
  }
}

export function filledFrom(sources: FieldSources | undefined, source: FieldSource): string[] {
  if (!sources) return [];
  return Object.entries(sources)
    .filter(([, value]) => value === source)
    .map(([key]) => key);
}
