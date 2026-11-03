import { getEngine } from "./engine";
import type { NoteKind } from "./types";

/**
 * 删除的限时撤销（先软删除）：删除前把论文（或整个领域）连同笔记、解析、作者关联、
 * 作业历史做一份应用层快照存进 localStorage（限时缓冲）；超时未撤销即丢弃快照——
 * 数据库里的真实级联清理在删除那一刻已经完成，快照只是这几秒的后悔药。撤销则按行
 * 原样回插（INSERT OR REPLACE，主键即原主键），笔记、关联与解析全部原样恢复。
 *
 * 不动 schema.ts（桌面端 restore.rs 与 user_version=6 锁步）：缓冲只在应用层。
 */

/** 通知上「撤销」按钮的停留时长：到期自动收起，撤销窗口随之结束。 */
export const DELETE_UNDO_TOAST_MS = 10_000;
/** 快照在缓冲里的兜底寿命（通知可因悬停暂停而活得比 10 秒长，这里放宽回收）。 */
export const DELETE_UNDO_TTL_MS = 60_000;

const BUFFER_KEY = "paper-field.delete-undo";

/** 一张表的行快照：列名 + 按列序对齐的行值（SELECT * 的原始列序）。 */
export interface TableSnapshot {
  table: string;
  columns: string[];
  rows: unknown[][];
}

export interface DeleteUndoData {
  /** kind = "domain" 时的领域行。 */
  domain?: TableSnapshot;
  papers: TableSnapshot;
  authors: TableSnapshot;
  paperAuthors: TableSnapshot;
  notes: TableSnapshot;
  parse: TableSnapshot;
  jobs: TableSnapshot;
}

export interface DeleteUndoEntry {
  kind: "papers" | "domain";
  /** 通知里给用户看的范围描述（论文标题或领域名）。 */
  label: string;
  at: number;
  paperIds: string[];
  /** 论文所属领域（papers kind 时为共同领域；domain kind 时即该领域）。 */
  domainId: string;
  /** 一并带走、撤销时原样放回的未保存笔记草稿。 */
  drafts: Record<string, Partial<Record<NoteKind, string>>>;
  data: DeleteUndoData;
}

async function snapshotTable(sql: string, params: unknown[], table: string): Promise<TableSnapshot> {
  const engine = await getEngine();
  const rows = await engine.select<Record<string, unknown>>(sql, params);
  if (!rows.length) return { table, columns: [], rows: [] };
  const columns = Object.keys(rows[0]!);
  return { table, columns, rows: rows.map((row) => columns.map((key) => row[key] ?? null)) };
}

function inClause(ids: string[]): string {
  return ids.map(() => "?").join(", ");
}

/** 论文及其全部关联（不含领域行）的行快照。 */
async function snapshotPapers(paperIds: string[]): Promise<DeleteUndoData> {
  const chunk = inClause(paperIds);
  const [papers, authors, paperAuthors, notes, parse, jobs] = await Promise.all([
    snapshotTable(`SELECT * FROM papers WHERE id IN (${chunk})`, paperIds, "papers"),
    snapshotTable(
      `SELECT DISTINCT a.* FROM authors a JOIN paper_authors pa ON pa.author_id = a.id WHERE pa.paper_id IN (${chunk})`,
      paperIds,
      "authors",
    ),
    snapshotTable(`SELECT * FROM paper_authors WHERE paper_id IN (${chunk})`, paperIds, "paper_authors"),
    snapshotTable(`SELECT * FROM notes WHERE paper_id IN (${chunk})`, paperIds, "notes"),
    snapshotTable(`SELECT * FROM paper_parse WHERE paper_id IN (${chunk})`, paperIds, "paper_parse"),
    snapshotTable(`SELECT * FROM llm_jobs WHERE paper_id IN (${chunk})`, paperIds, "llm_jobs"),
  ]);
  return { papers, authors, paperAuthors, notes, parse, jobs };
}

/** 删除论文前的快照（forgetPapers 之后、DELETE 之前调用：作业按已取消状态入快照，撤销后不留幽灵「进行中」）。 */
export async function capturePaperDelete(paperIds: string[], label: string): Promise<DeleteUndoEntry> {
  const engine = await getEngine();
  const rows = await engine.select<{ domain_id: string }>(
    `SELECT domain_id FROM papers WHERE id = ?`,
    [paperIds[0]!],
  );
  return {
    kind: "papers",
    label,
    at: Date.now(),
    paperIds: [...paperIds],
    domainId: rows[0]?.domain_id ?? "",
    drafts: {},
    data: await snapshotPapers(paperIds),
  };
}

/** 删除领域前的快照（含领域行与域内全部论文及关联）。 */
export async function captureDomainDelete(domainId: string, label: string): Promise<DeleteUndoEntry> {
  const engine = await getEngine();
  const paperIds = (
    await engine.select<{ id: string }>(`SELECT id FROM papers WHERE domain_id = ?`, [domainId])
  ).map((row) => row.id);
  const domain = await snapshotTable(`SELECT * FROM domains WHERE id = ?`, [domainId], "domains");
  return {
    kind: "domain",
    label,
    at: Date.now(),
    paperIds,
    domainId,
    drafts: {},
    data: { domain, ...(await snapshotPapers(paperIds)) },
  };
}

// 内存兜底：localStorage 写不进（隐私模式 / 配额满）时撤销在本次会话内仍可用。
let memoryEntry: DeleteUndoEntry | null = null;

/** 存入缓冲（只保留最近一次删除：更早的撤销窗口已被新的删除打断）。 */
export function saveDeleteUndo(entry: DeleteUndoEntry): void {
  memoryEntry = entry;
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(BUFFER_KEY, JSON.stringify(entry));
  } catch {
    // 存不下也保留内存副本：撤销在本次会话内仍可用。
  }
}

function clearStored(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(BUFFER_KEY);
  } catch {
    // 忽略：缓冲清理失败不影响主流程。
  }
}

function entryAlive(entry: DeleteUndoEntry): boolean {
  return Date.now() - entry.at <= DELETE_UNDO_TTL_MS;
}

/** 取出缓冲里的可撤销条目；已过期（超过兜底寿命）返回 null 并清掉缓冲。 */
export function takeDeleteUndo(): DeleteUndoEntry | null {
  const memory = memoryEntry;
  memoryEntry = null;
  if (memory && entryAlive(memory)) {
    clearStored();
    return memory;
  }
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(BUFFER_KEY);
    if (!raw) return null;
    localStorage.removeItem(BUFFER_KEY);
    const parsed = JSON.parse(raw) as DeleteUndoEntry;
    return entryAlive(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 缓冲里还有可撤销的删除吗（不取出、不清除）。 */
export function peekDeleteUndo(): DeleteUndoEntry | null {
  if (memoryEntry && entryAlive(memoryEntry)) return memoryEntry;
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(BUFFER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DeleteUndoEntry;
    return entryAlive(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 清空缓冲（测试与「窗口已过」后的主动清扫）。 */
export function clearDeleteUndo(): void {
  memoryEntry = null;
  clearStored();
}

/** 按行原样回插：领域 → 作者 → 论文 → 关联 → 笔记 → 解析 → 作业，一个事务完成。 */
export async function restoreDeleteUndo(entry: DeleteUndoEntry): Promise<void> {
  const engine = await getEngine();
  const order: TableSnapshot[] = [];
  if (entry.data.domain) order.push(entry.data.domain);
  order.push(
    entry.data.authors,
    entry.data.papers,
    entry.data.paperAuthors,
    entry.data.notes,
    entry.data.parse,
    entry.data.jobs,
  );
  const steps = order.flatMap((snapshot) =>
    snapshot.rows.map((row) => ({
      sql: `INSERT OR REPLACE INTO "${snapshot.table}" (${snapshot.columns
        .map((col) => `"${col}"`)
        .join(", ")}) VALUES (${snapshot.columns.map(() => "?").join(", ")})`,
      params: row,
    })),
  );
  if (steps.length) await engine.batch(steps);
}
