import { log } from "./logger";
import type { FieldSource, FieldSources, PaperDetail, PreparedMeta } from "./types";
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
}

export async function lookupPaper(paper: Pick<PaperDetail, "title" | "arxivId" | "doi">): Promise<PreparedMeta | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const hit = await invoke<LookupHit | null>("lookup_paper", {
      arxivId: paper.arxivId,
      doi: paper.doi,
      title: paper.title,
    });
    if (!hit?.title?.trim()) return null;
    return {
      title: hit.title.trim(),
      titleZh: null,
      abstract: hit.abstract?.trim() ?? "",
      year: typeof hit.year === "number" ? hit.year : null,
      venue: hit.venue?.trim() || null,
      doi: hit.doi?.trim() || null,
      arxivId: hit.arxivId?.trim() || null,
      authors: Array.isArray(hit.authors) ? hit.authors.filter((author) => author?.name?.trim()) : [],
      labs: [],
      codeOpenSource: "unknown",
      codeURL: null,
      projectPage: null,
      pdfURL: safeHttpUrl(hit.pdfUrl),
      tags: [],
      confidence: typeof hit.confidence === "number" ? hit.confidence : undefined,
    };
  } catch (err) {
    log.warn("llm", "文献库查询失败，已跳过", err instanceof Error ? err.message : String(err));
    return null;
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
