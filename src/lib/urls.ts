import { isTauri } from "./util";

/** http(s) only. `javascript:`, `file:`, and relative URLs are dropped. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return url.toString();
}

const ARXIV_NEW = /^\d{4}\.\d{4,5}(v\d+)?$/;
const ARXIV_OLD = /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/;

export function normalizeArxivId(value: string | null | undefined): string | null {
  if (!value) return null;
  let id = value.trim().replace(/^arxiv:/i, "");
  id = id.replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, "");
  id = id.replace(/\.pdf$/i, "");
  if (!ARXIV_NEW.test(id) && !ARXIV_OLD.test(id)) return null;
  return id.replace(/v\d+$/i, "");
}

export function arxivAbsUrl(value: string | null | undefined): string | null {
  const id = normalizeArxivId(value);
  if (!id) return null;
  return `https://arxiv.org/abs/${id}`;
}

export function arxivPdfUrl(value: string | null | undefined): string | null {
  const id = normalizeArxivId(value);
  if (!id) return null;
  return `https://arxiv.org/pdf/${id}`;
}

export function normalizeDoi(value: string | null | undefined): string | null {
  if (!value) return null;
  let doi = value.trim();
  doi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  if (!/^10\.\d{4,9}\/\S+$/.test(doi)) return null;
  if (/[\s<>"']/.test(doi)) return null;
  return doi;
}

export function doiUrl(value: string | null | undefined): string | null {
  const doi = normalizeDoi(value);
  if (!doi) return null;
  return `https://doi.org/${doi}`;
}

/** Open an http(s) URL in the system browser. The webview does not navigate. */
export async function openExternal(value: string | null | undefined): Promise<void> {
  const url = safeHttpUrl(value);
  if (!url) return;
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
