/**
 * 「接下来读」个人短队列（本机 localStorage）：与入库页的技术解析队列分开展示，
 * 只记论文 id（标题等从当前列表取，论文被删时自然消失）。
 */

const KEY = "paper-field.read-next";
/** 队列上限：个人阅读安排是短队列，超过按最旧移出。 */
export const READ_NEXT_LIMIT = 20;

export function readNextList(): string[] {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((id): id is string => typeof id === "string" && Boolean(id));
  } catch {
    return [];
  }
}

function persist(ids: string[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (ids.length) localStorage.setItem(KEY, JSON.stringify(ids));
    else localStorage.removeItem(KEY);
  } catch {
    // 存不下（隐私模式等）：本次会话内存态仍可用。
  }
}

/** 加入队列（已存在保持原位，不重复加入）；返回新队列。 */
export function readNextAdd(paperId: string): string[] {
  if (!paperId) return readNextList();
  const current = readNextList();
  if (current.includes(paperId)) return current;
  const ids = [...current, paperId].slice(-READ_NEXT_LIMIT);
  persist(ids);
  return ids;
}

/** 移出队列；返回新队列。 */
export function readNextRemove(paperId: string): string[] {
  const ids = readNextList().filter((id) => id !== paperId);
  persist(ids);
  return ids;
}

/** 调整顺序：to = top / up / down；非法移动原样返回。 */
export function readNextMove(paperId: string, to: "top" | "up" | "down"): string[] {
  const ids = readNextList();
  const at = ids.indexOf(paperId);
  if (at < 0) return ids;
  const target = to === "top" ? 0 : to === "up" ? at - 1 : at + 1;
  if (target < 0 || target >= ids.length || target === at) return ids;
  const next = [...ids];
  next.splice(at, 1);
  next.splice(target, 0, paperId);
  persist(next);
  return next;
}
