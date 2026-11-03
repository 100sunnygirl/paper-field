/**
 * 最近使用的领域（本机 localStorage 记忆，跨会话保留）：
 * 领域切换对话框据此把最近访问的领域置顶，减少多领域时的线性滚动。
 * 只存领域 id 的有序列表（最近在前）；领域被删除后残留的 id 会被读取方忽略。
 */

const KEY = "paper-field.domain-recent";
/** 最多记住多少个最近领域：够常用切换，也避免 localStorage 无界增长。 */
const RECENT_LIMIT = 9;

function isRecentList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= RECENT_LIMIT &&
    value.every((id) => typeof id === "string" && id.length > 0)
  );
}

/** 读取最近领域（最近在前）；localStorage 不可用或坏数据时返回空表。 */
export function loadRecentDomains(): string[] {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    return isRecentList(value) ? value : [];
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
    // 存不下（隐私模式等）：本次会话内仍有内存调用方自行排序的兜底。
  }
}

/** 记录一次领域访问：置顶、去重、超出上限裁掉最旧的。 */
export function recordDomainVisit(id: string): void {
  if (!id) return;
  const ids = loadRecentDomains().filter((item) => item !== id);
  ids.unshift(id);
  persist(ids.slice(0, RECENT_LIMIT));
}

/** 清空最近记录（供测试与「忘记最近使用」类入口使用）。 */
export function clearRecentDomains(): void {
  persist([]);
}

/**
 * 按最近使用给领域排序：最近访问的领域在前（保持各自的最近顺序），
 * 未访问过的领域按传入顺序（sort_order）排在后面。不修改原数组。
 */
export function orderDomainsByRecent<T extends { id: string }>(domains: T[], recent: string[]): T[] {
  const rank = new Map(recent.map((id, index) => [id, index]));
  return [...domains].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra === undefined && rb === undefined) return 0;
    if (ra === undefined) return 1;
    if (rb === undefined) return -1;
    return ra - rb;
  });
}
