// 重新解析的「旧版全文保留对照」：重新解析前把当前全文快照存到本机（localStorage，
// 口径与笔记草稿 / 阅读现场一致：不进数据库、不随备份走），新结果完成后给出两版对照，
// 由用户决定采用哪一版。快照只保留最近几篇、几天：它是「重解析期间的保护垫」，
// 不是版本历史。
const STORAGE_KEY = "paper-field.reparse-snapshot";
/** 最多同时保留几篇的快照（再多就裁最旧的）。 */
const MAX_RECORDS = 3;
/** 超过该天数未决的快照视为放弃对照，读取时丢弃。 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 全文的一组可对照统计：字数 / 小节数 / 表格行块 / 行内公式 / 图片引用。 */
export interface FulltextStats {
  chars: number;
  sections: number;
  tables: number;
  formulas: number;
  images: number;
}

/** 统计一段解析全文：小节按 ATX/setext 标题计（与 lib/fulltext 的提取口径近似即可）。 */
export function fulltextStats(markdown: string): FulltextStats {
  const text = markdown ?? "";
  const chars = [...text.replace(/\s+/g, " ").trim()].length;
  const sections = countHeadings(text);
  // Markdown 表格至少两行以 | 开头：按连续块数近似「张数」。
  const tables = blockCount(text, (line) => line.trimStart().startsWith("|"));
  // 公式：先数块级 $$…$$ 并从文本剔除（避免行内规则在 $$ 里重复命中），再数行内 $…$ 与 \(…\)。
  const blockFormulas = text.match(/\$\$[\s\S]+?\$\$/g) ?? [];
  const stripped = text.replace(/\$\$[\s\S]+?\$\$/g, "");
  const inlineFormulas =
    (stripped.match(/\$[^$\n]+\$/g) ?? []).length + (stripped.match(/\\\([\s\S]+?\\\)/g) ?? []).length;
  const images = (text.match(/!\[[^\]]*\]\([^)]*\)/g) ?? []).length;
  return { chars, sections, tables, formulas: blockFormulas.length + inlineFormulas, images };
}

function countHeadings(text: string): number {
  let count = 0;
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) inFence = !inFence;
    if (inFence) continue;
    if (/^#{1,6}\s+\S/.test(raw)) count += 1;
  }
  return count;
}

/** 相邻命中行归为一块（表格近似张数用）。 */
function blockCount(text: string, hit: (line: string) => boolean): number {
  let blocks = 0;
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const isHit = hit(raw);
    if (isHit && !inBlock) blocks += 1;
    inBlock = isHit;
  }
  return blocks;
}

export interface ReparseRecord {
  paperId: string;
  /** 重新解析前的全文与当时用的解析源。 */
  prev: {
    markdown: string;
    provider: string | null;
    /** 快照时刻（epoch 毫秒）。 */
    at: number;
  };
  /** 新结果完成后的摘要（未完成 / 失败时为 null：旧版仍是当前全文，无需对照）。 */
  next: {
    provider: string | null;
    at: number;
    chars: number;
    sections: number;
  } | null;
}

function isRecord(value: unknown): value is ReparseRecord {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.paperId === "string" &&
    typeof rec.prev === "object" &&
    rec.prev !== null &&
    typeof (rec.prev as Record<string, unknown>).markdown === "string" &&
    typeof (rec.prev as Record<string, unknown>).at === "number"
  );
}

function loadAll(): ReparseRecord[] {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    const now = Date.now();
    return value.filter(isRecord).filter((rec) => now - rec.prev.at < MAX_AGE_MS);
  } catch {
    return [];
  }
}

/** localStorage 写不下（隐私模式 / 配额满）时降级为仅内存：本次会话内对照仍可用。 */
let memoryOnly: ReparseRecord[] = [];

function persistAll(records: ReparseRecord[]): void {
  memoryOnly = records;
  try {
    if (typeof localStorage === "undefined") return;
    if (records.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 存不下不影响功能：内存副本仍生效（重启后没有对照，旧版此时已是当前全文）。
  }
}

function allRecords(): ReparseRecord[] {
  // localStorage 里的为准（内存副本只在持久化失败后有意义；两者由 persistAll 保持同步）。
  const stored = loadAll();
  const ids = new Set(stored.map((rec) => rec.paperId));
  return [...stored, ...memoryOnly.filter((rec) => !ids.has(rec.paperId))];
}

/** 重新解析前存当前全文快照（同篇重复调用覆盖旧快照，at 以最新为准）。 */
export function saveReparseSnapshot(input: {
  paperId: string;
  markdown: string;
  provider: string | null;
}): ReparseRecord {
  const record: ReparseRecord = {
    paperId: input.paperId,
    prev: { markdown: input.markdown, provider: input.provider, at: Date.now() },
    next: null,
  };
  const rest = allRecords().filter((rec) => rec.paperId !== input.paperId);
  persistAll([record, ...rest].slice(0, MAX_RECORDS));
  return record;
}

/** 新结果完成：给快照补上新版摘要，界面据此展示两版对照。 */
export function completeReparseSnapshot(
  paperId: string,
  next: { provider: string | null; chars: number; sections: number },
): void {
  const records = allRecords();
  const record = records.find((rec) => rec.paperId === paperId);
  if (!record) return;
  record.next = { ...next, at: Date.now() };
  persistAll(records);
}

/** 这篇的对照已了结（用户采用新版 / 恢复旧版，或重解析失败作废）。 */
export function clearReparseSnapshot(paperId: string): void {
  persistAll(allRecords().filter((rec) => rec.paperId !== paperId));
}

export function getReparseRecord(paperId: string): ReparseRecord | null {
  return allRecords().find((rec) => rec.paperId === paperId) ?? null;
}

/** 测试专用：清空全部快照（含内存副本）。 */
export function resetReparseSnapshots(): void {
  memoryOnly = [];
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略：清不掉不影响用例。
  }
}
