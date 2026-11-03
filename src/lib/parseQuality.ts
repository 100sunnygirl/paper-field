// 解析完成的质量提示：对刚解析出的全文做静态检查，把「值得再看一眼」的信号摆在明处。
// 只报告可从全文与提交参数算出的信号（空全文、疑似空页、表格 / 公式疑似丢失、标题数异常），
// 不猜测语义质量。PDF 实际页数前端拿不到：页数不符只按「相对小节数异常」给出弱提示。
import type { MineruSettingsV2 } from "./mineru";
import { parsePageRange } from "./mineruPreflight";

export interface ParseQualityWarning {
  kind: "empty" | "blank-page" | "missing-tables" | "missing-formulas" | "sparse";
  message: string;
}

/**
 * 相邻标题之间没有任何正文的次数（疑似空页 / 漏析段）。表格行也算正文；
 * 文档大标题（h1）之后直接跟第一个小节不算——那是正常的章节结构。
 */
function blankGapCount(markdown: string): number {
  const lines = markdown.split(/\r?\n/);
  let blanks = 0;
  let sawHeading = false;
  let lastLevel = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+\S/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (sawHeading && !(lastLevel === 1 && level > 1 && blanks === 0)) blanks += 1;
      sawHeading = true;
      lastLevel = level;
      continue;
    }
    if (line.trim()) {
      sawHeading = false;
      lastLevel = 0;
    }
  }
  return blanks;
}

/**
 * 解析完成后的静态质量检查。options：
 * - enableFormula / enableTable：官方 API 的提交开关（关掉时「丢失」不算异常，直接不算）。
 * - pageRange：页码范围非 all 时全文天然缺页，不给 sparse 提示。
 */
export function checkParseQuality(
  markdown: string,
  options: Pick<MineruSettingsV2, "pageRange"> & { enableFormula: boolean; enableTable: boolean },
): ParseQualityWarning[] {
  const warnings: ParseQualityWarning[] = [];
  const text = markdown ?? "";
  if (!text.replace(/\s+/g, "").length) {
    return [{ kind: "empty", message: "解析结果为空：没有取回任何文本。可能全文还在生成，或该源未返回结果。" }];
  }
  const headings = (text.match(/^#{1,6}\s+\S/gm) ?? []).length;
  const paragraphs = text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^#{1,6}\s/.test(line) && !line.trimStart().startsWith("|")).length;
  const tables = (text.match(/^\s*\|/gm) ?? []).length;
  const formulas =
    (text.replace(/\$\$[\s\S]+?\$\$/g, "").match(/\$[^$\n]+\$/g) ?? []).length +
    (text.match(/\\\([\s\S]+?\\\)/g) ?? []).length +
    (text.match(/\$\$[\s\S]+?\$\$/g) ?? []).length;
  const blanks = blankGapCount(text);
  if (blanks > 0) {
    warnings.push({
      kind: "blank-page",
      message: `有 ${blanks} 处标题之间没有正文，可能是空页或漏析的段落，建议对照原 PDF。`,
    });
  }
  if (options.enableTable && paragraphs >= 12 && tables === 0 && headings >= 2) {
    warnings.push({
      kind: "missing-tables",
      message: "全文没有表格：如果原论文有实验表，可能是表格解析失败，可换模型版本重新解析。",
    });
  }
  if (options.enableFormula && paragraphs >= 12 && formulas === 0 && headings >= 2) {
    warnings.push({
      kind: "missing-formulas",
      message: "全文没有公式：理工论文常见行内 / 行间公式缺失时值得一查，可换模型版本重新解析。",
    });
  }
  const range = parsePageRange(options.pageRange);
  if (range.pages === null && paragraphs < headings && headings >= 6) {
    warnings.push({
      kind: "sparse",
      message: "全文以标题为主、正文很少：可能只解析出部分页面，建议对照原 PDF 页数。",
    });
  }
  return warnings;
}
