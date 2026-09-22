import type { DraftedNotes, PaperDetail, PreparedMeta } from "./types";

export const PREPARE_META_SYSTEM = `You are a research librarian filling structured metadata for a local paper notes app.
Return ONLY valid JSON matching this schema:
{
  "title": "",
  "titleZh": "",
  "abstract": "",
  "year": 2024,
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
- Prefer the MinerU markdown when it is present. It is the text of the local PDF.
- Use the provided title / arXiv / DOI only as hints. If you recognize the paper, fill accurate public metadata.
- titleZh should be a concise Chinese translation when possible, else null.
- codeOpenSource: open if official code is public; closed if weights/code are known unreleased; request if available on request; unknown otherwise.
- pdfURL is a public link only. Never replace or invent the local file path.
- Never invent a DOI or arXiv id. Leave fields null when unsure.
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
}): string {
  const markdown = excerpt(input.parsedMarkdown);
  return [
    `Title: ${input.title}`,
    input.arxivId ? `arXiv: ${input.arxivId}` : null,
    input.doi ? `DOI: ${input.doi}` : null,
    input.pdfPath ? `Local PDF: ${input.pdfPath}` : null,
    input.pdfUrl ? `Public PDF: ${input.pdfUrl}` : null,
    input.abstract ? `Abstract already on file:\n${input.abstract}` : null,
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

export function normalizeMeta(raw: PreparedMeta, fallbackTitle: string): PreparedMeta {
  const open = raw.codeOpenSource;
  return {
    title: raw.title?.trim() || fallbackTitle,
    titleZh: raw.titleZh?.trim() || null,
    abstract: raw.abstract ?? "",
    year: typeof raw.year === "number" ? raw.year : null,
    venue: raw.venue || null,
    doi: raw.doi || null,
    arxivId: raw.arxivId || null,
    authors: Array.isArray(raw.authors) ? raw.authors.filter((a) => a?.name) : [],
    labs: Array.isArray(raw.labs) ? raw.labs.filter((l) => l?.name) : [],
    codeOpenSource:
      open === "open" || open === "closed" || open === "request" || open === "unknown" ? open : "unknown",
    codeURL: raw.codeURL || null,
    projectPage: raw.projectPage || null,
    pdfURL: raw.pdfURL || null,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    confidence: raw.confidence,
  };
}

export function normalizeNotes(raw: DraftedNotes): DraftedNotes {
  return {
    remarks: raw.remarks ?? "",
    summary: raw.summary ?? "",
    highlights: raw.highlights ?? "",
    weaknesses: raw.weaknesses ?? "",
    implications: raw.implications ?? "",
  };
}
