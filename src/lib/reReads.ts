/**
 * 复读记录（本机 localStorage）：库里 read_at 只保留首次标记已读的时间，
 * 复读（重读一遍）作为独立事件记在这里——{ at, note? } 按论文分组。
 *
 * 为什么不放数据库：schema 升 v7 与桌面端 restore.rs 的 SCHEMA_VERSION=6 锁步、
 * 拒绝恢复更新版本库（见 PROGRESS 模块08 记录），故沿用 jobJournal / readingSince
 * 的本机记录先例；界面措辞如实标注「本机记录」。
 */

export interface ReReadRecord {
  /** ISO 时间戳。 */
  at: string;
  /** 复读备注（可空）。 */
  note?: string;
}

const KEY = "paper-field.re-reads";
/** 每篇论文保留的复读记录上限（超出裁最旧的）。 */
const PER_PAPER_LIMIT = 50;
/** 记录的论文数上限（超出裁记录最少且最久未更新的）。 */
const PAPERS_LIMIT = 500;

type Store = Record<string, ReReadRecord[]>;

function load(): Store {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Store = {};
    for (const [paperId, records] of Object.entries(value as Record<string, unknown>)) {
      if (!Array.isArray(records)) continue;
      const clean = records
        .map((record) => {
          if (!record || typeof record !== "object") return null;
          const at = (record as { at?: unknown }).at;
          const note = (record as { note?: unknown }).note;
          if (typeof at !== "string" || Number.isNaN(new Date(at).getTime())) return null;
          return typeof note === "string" && note.trim() ? { at, note: note.trim() } : { at };
        })
        .filter((record): record is ReReadRecord => record !== null);
      if (clean.length) out[paperId] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(store: Store): void {
  try {
    if (typeof localStorage === "undefined") return;
    const ids = Object.keys(store);
    if (ids.length) localStorage.setItem(KEY, JSON.stringify(store));
    else localStorage.removeItem(KEY);
  } catch {
    // 存不下（隐私模式等）：本次会话内存态仍可用，下次读写再试。
  }
}

/** 这篇论文的全部复读记录（按时间升序）。 */
export function listReReads(paperId: string): ReReadRecord[] {
  return load()[paperId] ?? [];
}

/** 记录一次复读（可带备注）；返回记录后的全部记录。 */
export function recordReRead(paperId: string, note?: string, now: Date = new Date()): ReReadRecord[] {
  if (!paperId) return [];
  const store = load();
  const records = [...(store[paperId] ?? []), { at: now.toISOString(), ...(note?.trim() ? { note: note.trim() } : {}) }];
  store[paperId] = records.slice(-PER_PAPER_LIMIT);
  // 超出论文数上限：裁掉记录最少的一篇（并列时最久未更新的）。
  const ids = Object.keys(store);
  if (ids.length > PAPERS_LIMIT) {
    const sorted = ids.sort((a, b) => {
      const la = store[a]![store[a]!.length - 1]?.at ?? "";
      const lb = store[b]![store[b]!.length - 1]?.at ?? "";
      return store[a]!.length - store[b]!.length || la.localeCompare(lb);
    });
    delete store[sorted[0]!];
  }
  persist(store);
  return store[paperId] ?? [];
}

/** 清除这篇论文的复读记录。 */
export function clearReReads(paperId: string): void {
  if (!paperId) return;
  const store = load();
  if (!(paperId in store)) return;
  delete store[paperId];
  persist(store);
}
