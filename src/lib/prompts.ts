import type { DraftedNotes, PaperDetail, PreparedMeta } from "./types";
import { safeHttpUrl } from "./urls";

export const PREPARE_META_SYSTEM = `You are a research librarian filling structured metadata for a local paper notes app.
Return ONLY valid JSON matching this schema:
{
  "title": "",
  "titleZh": "",
  "abstract": "",
  "year": null,
  "venue": "",
  "doi": "",
  "arxivId": "",
  "authors": [{"name":"","affiliation":"","lab":"","isCorresponding":false}],
  "labs": [{"name":"","institution":""}],
  "codeOpenSource": "unknown|open|closed|request",
  "codeURL": null,
  "projectPage": null,
  "pdfURL": null,
  "tags": [],
  "confidence": 0.0
}
Rules:
- Bibliographic fields (title, authors, year, venue, abstract, DOI, arXiv, pdf URL) may already be filled from arXiv, Crossref, or OpenAlex. Leave those null.
- Always output null for doi, arxivId and year: identifiers come only from the user or a bibliographic database.
- Fill only fields that are still empty: titleZh, tags, labs, codeOpenSource, codeURL, projectPage.
- titleZh should be a concise Chinese translation when possible, else null.
- codeOpenSource: open if official code is public; closed if weights/code are known unreleased; request if available on request; unknown otherwise.
- codeURL and projectPage must be http or https. Never invent a DOI, arXiv id, or local file path.
- Do not mention reading status. Do not output markdown.`;

export const DRAFT_NOTES_SYSTEM = `You draft first-person research notes for a human who will edit them.
Return ONLY valid JSON:
{
  "remarks": "",
  "summary": "",
  "highlights": "",
  "weaknesses": "",
  "implications": ""
}
Write in Chinese if the user's other fields are Chinese, otherwise match the paper language.
- summary: 4–8 sentences in the reader's voice.
- highlights / weaknesses: markdown bullet lists.
- remarks: practical lab notes (repro, code, what to check).
- implications: what this paper changes for the current research domain.
Be specific. No reading-status language. No fake citations.`;

function excerpt(value: string | null | undefined, max = 12000): string | null {
  const text = value?.trim();
  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated]`;
}

export function prepareMetaUserPrompt(input: {
  title: string;
  arxivId?: string | null;
  doi?: string | null;
  pdfUrl?: string | null;
  pdfPath?: string | null;
  abstract?: string | null;
  parsedMarkdown?: string | null;
  /** Fields already stored from a bibliographic API; the model must not refill them. */
  filledByApi?: string[];
}): string {
  const markdown = excerpt(input.parsedMarkdown);
  const filled = input.filledByApi?.filter(Boolean) ?? [];
  return [
    `Title: ${input.title}`,
    input.arxivId ? `arXiv: ${input.arxivId}` : null,
    input.doi ? `DOI: ${input.doi}` : null,
    input.pdfUrl ? `Public PDF: ${input.pdfUrl}` : null,
    input.abstract ? `Abstract already on file:\n${input.abstract}` : null,
    filled.length ? `Already filled from a bibliographic database (leave these null): ${filled.join(", ")}` : null,
    markdown ? `MinerU markdown:\n${markdown}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function draftNotesUserPrompt(paper: PaperDetail): string {
  const authors = paper.authors.map((a) => `${a.name}${a.affiliation ? ` (${a.affiliation})` : ""}`).join("; ");
  return [
    `Title: ${paper.title}`,
    paper.titleZh ? `Chinese title: ${paper.titleZh}` : null,
    paper.year ? `Year: ${paper.year}` : null,
    paper.venue ? `Venue: ${paper.venue}` : null,
    authors ? `Authors: ${authors}` : null,
    paper.tags.length ? `Tags: ${paper.tags.join(", ")}` : null,
    "",
    "Abstract:",
    paper.abstract || "(none)",
    excerpt(paper.parsedMarkdown) ? `\nMinerU markdown:\n${excerpt(paper.parsedMarkdown)}` : null,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** 模型输出类型不可信：字符串字段只收字符串（数字转成文本），其他类型一律当空。 */
function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * 规整模型 JSON。不再用当前标题兜底：模型没给标题就是没给，不能借机把来源改成「模型」。
 * DOI / arXiv / 年份照常解析，但合并时模型来源的标识符不会写入（见 mergeMeta.decide）。
 */
export function normalizeMeta(raw: PreparedMeta): PreparedMeta {
  const open = raw.codeOpenSource;
  const authors = Array.isArray(raw.authors) ? raw.authors : [];
  const labs = Array.isArray(raw.labs) ? raw.labs : [];
  return {
    title: text(raw.title),
    titleZh: text(raw.titleZh) || null,
    abstract: text(raw.abstract),
    year: typeof raw.year === "number" && Number.isFinite(raw.year) ? Math.trunc(raw.year) : null,
    venue: text(raw.venue) || null,
    doi: text(raw.doi) || null,
    arxivId: text(raw.arxivId) || null,
    authors: authors
      .filter((a) => a && typeof a === "object" && text(a.name))
      .map((a) => ({
        name: text(a.name),
        affiliation: text(a.affiliation) || null,
        lab: text(a.lab) || null,
        isCorresponding: a.isCorresponding === true,
      })),
    labs: labs
      .filter((l) => l && typeof l === "object" && text(l.name))
      .map((l) => ({ name: text(l.name), institution: text(l.institution) })),
    codeOpenSource:
      open === "open" || open === "closed" || open === "request" || open === "unknown" ? open : "unknown",
    codeURL: safeHttpUrl(text(raw.codeURL)),
    projectPage: safeHttpUrl(text(raw.projectPage)),
    pdfURL: safeHttpUrl(text(raw.pdfURL)),
    tags: Array.isArray(raw.tags) ? raw.tags.map(text).filter(Boolean) : [],
    confidence: typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? raw.confidence : undefined,
  };
}

export function normalizeNotes(raw: DraftedNotes): DraftedNotes {
  const note = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    remarks: note(raw.remarks),
    summary: note(raw.summary),
    highlights: note(raw.highlights),
    weaknesses: note(raw.weaknesses),
    implications: note(raw.implications),
  };
}
