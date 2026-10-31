// 提交解析前的预检：只算前端真知道的事——页码范围写法与算出的页数、本批预计页数、
// 官方 API 限额对照。文件大小与 PDF 实际页数前端读不到本机文件（桌面端提交时由后端
// 核验 200MB 上限，见 src-tauri/src/mineru_api.rs 的 submit）；当日已用额度官方 API
// 没有查询接口。预检不假装知道这些，只把可算的算清、把限额摆在明处。
import type { MineruSettingsV2 } from "./mineru";

/** 官方 API 的公开限额（README 同口径）。 */
export const API_LIMITS = { fileMb: 200, pagesPerFile: 200, filesPerBatch: 50, pagesPerDay: 1000 };

export interface PageRangeInfo {
  /** 按写法算出的页数；all（全部页）或写法无法解析时为 null。 */
  pages: number | null;
  /** 写法能否识别（"1-3,5" / "all"；其他字符不认）。 */
  valid: boolean;
}

/** 解析页码范围写法："all" → 全部页（页数未知）；"1-3,5" → 4 页；非法写法 valid=false。 */
export function parsePageRange(range: string): PageRangeInfo {
  const text = (range ?? "").trim();
  if (!text || text.toLowerCase() === "all") return { pages: null, valid: true };
  let total = 0;
  for (const part of text.split(",")) {
    const seg = part.trim();
    if (!seg) return { pages: null, valid: false };
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(seg);
    if (rangeMatch) {
      const from = Number(rangeMatch[1]);
      const to = Number(rangeMatch[2]);
      if (to < from) return { pages: null, valid: false };
      total += to - from + 1;
      continue;
    }
    if (/^\d+$/.test(seg)) {
      total += 1;
      continue;
    }
    return { pages: null, valid: false };
  }
  return { pages: total, valid: true };
}

export interface PreflightView {
  /** 官方 API 是否在启用链里：只有它受这些限额约束（本地 / SSH 无页数与额度限制）。 */
  apiInChain: boolean;
  pageRange: PageRangeInfo;
  /** 本批预计页数（文件数 × 每篇页数）；页数未知（all）时为 null。 */
  estPages: number | null;
  /** 超限或写法问题：会标红，附下一步建议。 */
  warnings: string[];
  /** 限额与口径说明（不标红）。 */
  notes: string[];
}

/** 一批文件的提交前预检：files 为本批文件数（单篇重试传 1）。 */
export function mineruPreflight(input: { files: number; settings: MineruSettingsV2 }): PreflightView {
  const { files, settings } = input;
  const apiInChain = settings.api.hasToken;
  const pageRange = parsePageRange(settings.pageRange);
  const estPages = pageRange.pages !== null ? pageRange.pages * Math.max(0, files) : null;
  if (!apiInChain) {
    // 本地 / SSH 不受官方 API 限额约束；页码写法问题仍然值得提醒（取回全文时同样带上）。
    const warnings = !pageRange.valid ? [`页码范围「${settings.pageRange}」无法识别：应写如 1-3,5 或 all。`] : [];
    return { apiInChain, pageRange, estPages, warnings, notes: [] };
  }
  const warnings: string[] = [];
  const notes: string[] = [`官方 API 限额：单文件 ≤${API_LIMITS.fileMb}MB / ≤${API_LIMITS.pagesPerFile} 页 · 每日 ${API_LIMITS.pagesPerDay} 页`];
  if (!pageRange.valid) {
    warnings.push(
      `页码范围「${settings.pageRange}」无法识别：官方 API 应写如 1-3,5 或 all，当前写法提交会被拒绝。`,
    );
  }
  if (pageRange.pages !== null && pageRange.pages > API_LIMITS.pagesPerFile) {
    warnings.push(
      `页码范围共 ${pageRange.pages} 页，超过官方 API 单文件 ${API_LIMITS.pagesPerFile} 页上限（错误码 -60006）。可缩小页码范围（如先解析前 20 页），或改用本地 / SSH 解析源。`,
    );
  }
  if (estPages !== null && estPages > API_LIMITS.pagesPerDay) {
    warnings.push(
      `本批 ${files} 篇 × 每篇 ${pageRange.pages} 页 ≈ ${estPages} 页，超过官方 API 每日 ${API_LIMITS.pagesPerDay} 页额度（-60018）。可分批导入或缩小页码范围。`,
    );
  }
  if (files > API_LIMITS.filesPerBatch) {
    notes.push(
      `本批 ${files} 个文件超过官方 API 单次提交 ${API_LIMITS.filesPerBatch} 个的上限；本应用逐篇提交不受这条限制，页数仍按总量计入当日额度。`,
    );
  }
  if (pageRange.pages === null && pageRange.valid) {
    notes.push(
      `页码范围为 all：以 PDF 实际页数为准（超过 ${API_LIMITS.pagesPerFile} 页 / ${API_LIMITS.fileMb}MB 的文件会被官方 API 拒绝）；文件大小与实际页数在提交时由桌面端核验。`,
    );
  }
  notes.push("当日已用页数官方 API 暂无查询接口，无法预先显示剩余额度。");
  return { apiInChain, pageRange, estPages, warnings, notes };
}
