// 解析结果的人工校正层（本机）：对某一小节标记「解析有误」并附本地校正文本。
// 口径与笔记草稿 / 阅读现场一致——存 localStorage、不进数据库、不随备份走；
// 全文重新解析后小节内容会变，锚点不再匹配的校正会被自动清掉（保留会误导）。
// 原始解析结果不改动：校正只在本机展示层生效，「查看原文」随时可对照。

const STORAGE_KEY = "paper-field.parse-corrections";
/** 最多保留篇数（裁最旧）：校正层是轻量修补，不是编辑器。 */
const MAX_PAPERS = 20;

/** 一条校正：锚定到某版全文的某个小节（按小节标题文本 + 该版全文长度识别）。 */
export interface ParseCorrection {
  /** 小节锚点 id（fulltext.ts 的 ft-sec-N）。 */
  sectionId: string;
  /** 小节标题文本（§编号 + 标题），展示与复核用。 */
  sectionLabel: string;
  /** 该版全文的字符数：重新解析后全文变化即视为锚点失效。 */
  fulltextChars: number;
  /** 校正说明（为什么解析有误）。 */
  note: string;
  /** 本地校正后的文本（该小节的正确内容；空串 = 仅标记有误不改正文）。 */
  fixed: string;
  at: number;
}

export interface PaperCorrections {
  paperId: string;
  /** 该版全文的字符数（锚点有效性校验）。 */
  fulltextChars: number;
  corrections: ParseCorrection[];
}

function loadAll(): PaperCorrections[] {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is PaperCorrections =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as PaperCorrections).paperId === "string" &&
        typeof (item as PaperCorrections).fulltextChars === "number" &&
        Array.isArray((item as PaperCorrections).corrections),
    );
  } catch {
    return [];
  }
}

function persistAll(records: PaperCorrections[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (records.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 存不下不影响阅读：校正层是本机增强，静默降级。
  }
}

/** 这篇论文当前这版全文的校正记录；全文变了（重新解析）返回 null（旧校正作废）。 */
export function getCorrections(paperId: string, markdown: string): PaperCorrections | null {
  const record = loadAll().find((item) => item.paperId === paperId);
  if (!record) return null;
  if (record.fulltextChars !== [...(markdown ?? "")].length) return null;
  return record;
}

export function saveCorrection(input: {
  paperId: string;
  markdown: string;
  sectionId: string;
  sectionLabel: string;
  note: string;
  fixed: string;
}): void {
  const chars = [...(input.markdown ?? "")].length;
  const records = loadAll().filter((item) => item.paperId !== input.paperId);
  const existing = records.find((item) => item.paperId === input.paperId && item.fulltextChars === chars);
  const correction: ParseCorrection = {
    sectionId: input.sectionId,
    sectionLabel: input.sectionLabel,
    fulltextChars: chars,
    note: input.note,
    fixed: input.fixed,
    at: Date.now(),
  };
  if (existing) {
    existing.corrections = [
      ...existing.corrections.filter((item) => item.sectionId !== input.sectionId),
      correction,
    ];
  } else {
    records.unshift({ paperId: input.paperId, fulltextChars: chars, corrections: [correction] });
  }
  persistAll(records.slice(0, MAX_PAPERS));
}

export function removeCorrection(paperId: string, sectionId: string): void {
  const records = loadAll();
  const record = records.find((item) => item.paperId === paperId);
  if (!record) return;
  record.corrections = record.corrections.filter((item) => item.sectionId !== sectionId);
  if (!record.corrections.length) persistAll(records.filter((item) => item.paperId !== paperId));
  else persistAll(records);
}

/** 放弃这篇的全部校正（回到原始解析结果）。 */
export function clearCorrections(paperId: string): void {
  persistAll(loadAll().filter((item) => item.paperId !== paperId));
}

/** 测试专用。 */
export function resetCorrections(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略。
  }
}

/**
 * 应用校正层后的展示文本：被校正的小节替换为 fixed（非空时），并在文末附校正记录清单。
 * 没有生效校正时原样返回。
 */
export function applyCorrections(markdown: string, record: PaperCorrections | null): string {
  if (!record?.corrections.length) return markdown;
  const lines = markdown.split(/\r?\n/);
  // 小节区间按标题行切（ft-sec-N 与标题出现顺序一致，编号即第 N 个标题）。
  const headingLines: number[] = [];
  let fenceChar: string | null = null;
  lines.forEach((line, index) => {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const mark = fence[1][0];
      if (!fenceChar) fenceChar = mark;
      else if (mark === fenceChar) fenceChar = null;
      return;
    }
    if (fenceChar) return;
    if (/^ {0,3}#{1,6}\s+\S/.test(line)) headingLines.push(index);
  });
  // 从后往前替换：前面小区间的行号不受影响。
  const ordered = [...record.corrections].sort(
    (a, b) => rank(b.sectionId) - rank(a.sectionId),
  );
  for (const correction of ordered) {
    if (!correction.fixed.trim()) continue;
    const index = rank(correction.sectionId) - 1;
    const start = headingLines[index];
    if (start === undefined) continue;
    const end = index + 1 < headingLines.length ? headingLines[index + 1] : lines.length;
    lines.splice(start, end - start, lines[start], "", correction.fixed.trim(), "");
  }
  return lines.join("\n");
}

function rank(sectionId: string): number {
  return Number(sectionId.replace("ft-sec-", "")) || 0;
}
