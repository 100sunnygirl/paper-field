/**
 * 「暂缓处理」的失败论文（本机 localStorage）：从入库主视野折叠到次要区，
 * 不参与主列表，也不计入失败聚类的默认展开；随时可恢复处理。
 */

const KEY = "paper-field.intake-deferred";

export function deferredPaperIds(): string[] {
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

export function deferPaper(paperId: string): string[] {
  const ids = deferredPaperIds();
  if (!paperId || ids.includes(paperId)) return ids;
  const next = [...ids, paperId];
  persist(next);
  return next;
}

export function undeferPaper(paperId: string): string[] {
  const next = deferredPaperIds().filter((id) => id !== paperId);
  persist(next);
  return next;
}
