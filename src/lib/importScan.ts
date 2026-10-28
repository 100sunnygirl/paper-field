// 导入预览的本地扫描：从文件名提取 arXiv 号、清洗出标题候选，并对照库内论文找出
// 「换文件名/换路径也会撞上」的重复候选（arXiv 一致 / 标题一致或高度相似）。
// 内容哈希比对需要读文件字节（桌面端 Rust），这里只做文件名与库内著录的比对，不臆造。

import { normalizeArxivId } from "./urls";

export interface PaperRef {
  id: string;
  title: string;
  titleZh: string | null;
  arxivId: string | null;
  doi: string | null;
  domainId: string;
  domainName: string;
  pdfPath: string | null;
  pdfOriginalPath: string | null;
}

export type DedupBasis = "arxiv" | "title";

export interface DedupCandidate {
  paperId: string;
  /** 展示标题（优先中文标题）。 */
  title: string;
  domainName: string;
  basis: DedupBasis;
  /** 匹配依据的中文说明，如「arXiv 1706.03762 相同」/「标题一致」/「标题相似」。 */
  detail: string;
}

export interface ImportItemScan {
  arxivId: string | null;
  cleanTitle: string | null;
  candidate: DedupCandidate | null;
}

/** 文件名里最像 arXiv 号的片段（新式 2401.12345；旧式形如 cs.CL/0703012 少见，暂不认）。 */
export function extractArxivFromFilename(filename: string): string | null {
  const match = /(?:^|[\s_\-[(])(\d{4}\.\d{4,5})(?:v\d+)?(?=[\s_\-\])].|$)/i.exec(
    filename.replace(/\.pdf$/i, ""),
  );
  return match ? normalizeArxivId(match[1]) : null;
}

/**
 * 文件名清洗成标题候选：去扩展名、去开头的 arXiv 编号（`1706.03762 Attention…`
 * `arXiv_2301.00001_…` `[2310.06692] …`）、下划线折成空格。认不出的部分原样保留。
 */
export function cleanPdfTitle(filename: string): string | null {
  let base = filename.replace(/\.pdf$/i, "").trim();
  base = base.replace(/^[\[\(]?\s*(?:arxiv[\s_:~-]*)?\d{4}\.\d{4,5}(v\d+)?\s*[\]\)]?[\s_:~-]+/i, "");
  base = base.replace(/[_]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return base || null;
}

/** 匹配用归一：NFKC 折宽、小写、去空白与标点（保留字母数字与中日韩）。 */
export function normalizeTitleForMatch(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function trigrams(value: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= value.length; i += 1) grams.add(value.slice(i, i + 3));
  return grams;
}

/** 字符 3-gram Dice 系数（0-1）：与文献库匹配口径同族，阈值取保守值。 */
export function titleSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const gram of left) if (right.has(gram)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

/** 标题相似门槛：低于它的不算候选（宁漏勿误，避免整批误标）。 */
const SIMILAR_THRESHOLD = 0.78;
/** 参与相似比对的标题最短归一长度（太短的文件名谁都能撞上）。 */
const MIN_MATCH_LENGTH = 6;

/**
 * 扫一个待导入文件：提取 arXiv 号、清洗标题，并对照库内引用找重复候选。
 * 依据优先级：arXiv 一致 > 标题一致 > 标题相似；都不中返回 candidate: null。
 */
export function scanImportItem(filename: string, refs: PaperRef[]): ImportItemScan {
  const arxivId = extractArxivFromFilename(filename);
  const cleanTitle = cleanPdfTitle(filename);
  let candidate: DedupCandidate | null = null;

  if (arxivId) {
    const hit = refs.find((ref) => ref.arxivId && normalizeArxivId(ref.arxivId) === arxivId);
    if (hit) {
      candidate = {
        paperId: hit.id,
        title: hit.titleZh || hit.title,
        domainName: hit.domainName,
        basis: "arxiv",
        detail: `arXiv ${arxivId} 相同`,
      };
    }
  }

  if (!candidate && cleanTitle) {
    const norm = normalizeTitleForMatch(cleanTitle);
    if (norm.length >= MIN_MATCH_LENGTH) {
      const exact = refs.find(
        (ref) =>
          normalizeTitleForMatch(ref.title) === norm ||
          (ref.titleZh ? normalizeTitleForMatch(ref.titleZh) === norm : false),
      );
      if (exact) {
        candidate = {
          paperId: exact.id,
          title: exact.titleZh || exact.title,
          domainName: exact.domainName,
          basis: "title",
          detail: "标题一致",
        };
      } else {
        let best: { ref: PaperRef; score: number } | null = null;
        for (const ref of refs) {
          const score = Math.max(
            titleSimilarity(norm, normalizeTitleForMatch(ref.title)),
            ref.titleZh ? titleSimilarity(norm, normalizeTitleForMatch(ref.titleZh)) : 0,
          );
          if (!best || score > best.score) best = { ref, score };
        }
        if (best && best.score >= SIMILAR_THRESHOLD) {
          candidate = {
            paperId: best.ref.id,
            title: best.ref.titleZh || best.ref.title,
            domainName: best.ref.domainName,
            basis: "title",
            detail: "标题相似",
          };
        }
      }
    }
  }

  return { arxivId, cleanTitle, candidate };
}
