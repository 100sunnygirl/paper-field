// 手动添加的「粘贴识别」：把一段粘贴文本自动识别为 arXiv / DOI / BibTeX，
// 拆出可编辑字段（标题、arXiv、DOI、年份、出处、作者）。手写解析器，不引新依赖；
// BibTeX 只取常见著录字段，认不出的写法保持原文交给字段输入，不臆造。

import { normalizeArxivId, normalizeDoi } from "./urls";

export type ParsedRefKind = "arxiv" | "doi" | "bibtex";

export interface ParsedRef {
  kind: ParsedRefKind;
  /** 识别出的 arXiv id（已规整：去版本号、去链接前缀）。 */
  arxivId?: string;
  /** 识别出的 DOI（已规整）。 */
  doi?: string;
  /** BibTeX 的 title 字段（花括号与多空格已清理）。 */
  title?: string;
  /** BibTeX 的 year 字段（可解析为整数时）。 */
  year?: number | null;
  /** journal / booktitle，作为「会议 / 期刊」候选。 */
  venue?: string | null;
  /** BibTeX 的 author 字段按 " and " 拆开。 */
  authors?: string[];
}

const ARXIV_ANYWHERE =
  /(?:arxiv(?:\.org)?\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?|arxiv\s*[:：=]?\s*(\d{4}\.\d{4,5})(?:v\d+)?)\b/i;
const ARXIV_BARE_NEW = /^\d{4}\.\d{4,5}(v\d+)?$/;
const ARXIV_BARE_OLD = /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/;
const DOI_ANYWHERE = /\b(10\.\d{4,9}\/[^\s<>"']+)/;

/** 全角转半角后再找标识符（中文输入法的「：」、全角数字都会折掉）。 */
function foldWidthText(text: string): string {
  return text.normalize("NFKC").replace(/[\u00a0\u3000]/g, " ");
}

/** 在整段文本里找第一个形如 arXiv 号的片段（支持 arxiv.org/abs|pdf 链接与 arXiv: 前缀）。 */
function findArxiv(text: string): string | null {
  const folded = foldWidthText(text);
  // 整段就是一串裸 arXiv 号（旧式 cs.CL/0703012 也算），不用前缀佐证。
  if (ARXIV_BARE_NEW.test(folded.trim()) || ARXIV_BARE_OLD.test(folded.trim())) {
    return normalizeArxivId(folded.trim());
  }
  const match = ARXIV_ANYWHERE.exec(folded);
  if (!match) return null;
  const id = match[1] ?? match[2];
  return id ? normalizeArxivId(id) : null;
}

/** 在整段文本里找 DOI（支持 doi.org 链接与 doi: 前缀；结尾标点剥掉）。 */
function findDoi(text: string): string | null {
  const folded = foldWidthText(text);
  const match = /\b(?:https?:\/\/)?(?:(?:dx|www)\.)?doi\.org\/\S+|doi\s*[:：=]?\s*\S+/i.exec(folded);
  if (match) {
    const doi = normalizeDoi(match[0].replace(/[.,;)\]]+$/, ""));
    if (doi) return doi;
  }
  const bare = DOI_ANYWHERE.exec(folded)?.[1];
  return bare ? normalizeDoi(bare.replace(/[.,;)\]]+$/, "")) : null;
}

/** BibTeX 字符串值：剥外层花括号/引号，折掉多余空白与 TeX 花括号残片。 */
function cleanBibtexValue(raw: string): string {
  let value = raw.trim();
  // 反复剥一层 {..} 或 "..."（值本身可能再包一层保护性花括号，如 {Bert}）。
  for (let i = 0; i < 3; i += 1) {
    if (/^\{.*\}$/.test(value)) value = value.slice(1, -1).trim();
    else if (/^".*"$/.test(value)) value = value.slice(1, -1).trim();
    else break;
  }
  return value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

function parseYear(value: string): number | null {
  const match = /\b(\d{4})\b/.exec(value);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * 手写 BibTeX 条目解析：条目类型与键忽略，只取常见著录字段。
 * 认不出 `@` 开头以外的情况返回 null；字段解析失败的部分跳过，不抛错。
 */
function parseBibtex(text: string): ParsedRef | null {
  const entry = /@\w+\s*[({]/.exec(text);
  if (!entry) return null;
  const body = text.slice(entry.index);
  const fields = new Map<string, string>();
  // 逐字符扫过 `name = value` 对：以深度 0 的逗号分隔；值支持 {..}（可嵌套）与 "..."。
  let i = 0;
  while (i < body.length) {
    const nameMatch = /\s*([A-Za-z][\w-]*)\s*=\s*/.exec(body.slice(i));
    if (!nameMatch) break;
    // exec 不锚定：要跳到字段名真正出现的位置，再越过 `name =`。
    i += nameMatch.index + nameMatch[0].length;
    let value = "";
    if (body[i] === "{") {
      let depth = 0;
      const start = i;
      while (i < body.length) {
        if (body[i] === "{") depth += 1;
        else if (body[i] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        i += 1;
      }
      value = body.slice(start, Math.min(i + 1, body.length));
      i += 1;
    } else if (body[i] === '"') {
      const start = i + 1;
      const end = body.indexOf('"', start);
      const stop = end === -1 ? body.length : end;
      value = body.slice(start, stop);
      i = stop + 1;
    } else {
      const match = /[^\s,}]+/.exec(body.slice(i));
      if (!match) break;
      value = match[0];
      i += match.index + match[0].length;
    }
    fields.set(nameMatch[1].toLowerCase(), value);
    const comma = /\s*,?\s*/.exec(body.slice(i));
    if (comma) i += comma[0].length;
  }
  if (fields.size === 0) return null;
  const get = (key: string) => {
    const value = fields.get(key);
    return value ? cleanBibtexValue(value) : "";
  };
  const arxivFromEntry =
    normalizeArxivId(get("eprint")) ??
    (get("archiveprefix").toLowerCase().includes("arxiv") && get("eprint") ? normalizeArxivId(get("eprint")) : null) ??
    (get("url") ? findArxiv(get("url")) : null);
  const title = get("title");
  const venue = get("journal") || get("booktitle") || null;
  const authors = get("author")
    ? get("author")
        .split(/\s+and\s+/i)
        .map((name) => name.trim())
        .filter(Boolean)
    : undefined;
  const ref: ParsedRef = {
    kind: "bibtex",
    arxivId: arxivFromEntry ?? undefined,
    doi: normalizeDoi(get("doi")) ?? undefined,
    title: title || undefined,
    year: fields.has("year") ? parseYear(get("year")) : null,
    venue: venue || null,
    authors: authors?.length ? authors : undefined,
  };
  return ref;
}

/**
 * 识别一段粘贴文本。识别优先级：BibTeX（`@` 开头的条目）> arXiv > DOI；
 * 都认不出返回 null（调用方保留原文本，字段仍可手填）。
 */
export function parsePastedRef(text: string): ParsedRef | null {
  const value = text.trim();
  if (!value) return null;
  const bibtex = parseBibtex(value);
  if (bibtex) return bibtex;
  const arxiv = findArxiv(value);
  if (arxiv) return { kind: "arxiv", arxivId: arxiv };
  const doi = findDoi(value);
  if (doi) return { kind: "doi", doi };
  return null;
}
