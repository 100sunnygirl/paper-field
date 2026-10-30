/**
 * 每个领域的列表现场（本机 localStorage 记忆，跨会话保留）：
 * - search：在这个领域用的搜索词（切走时保存、切回时恢复，不沿用别的领域的条件）
 * - paperId：离开时选中的论文（切回时若仍在本领域则恢复选中）
 * - listTop：论文列表 .ef-paper-list 的滚动位置
 * 坏数据（缺字段 / 类型不对）整条丢弃，不影响其他领域。
 */

export interface DomainSpot {
  search: string;
  paperId: string | null;
  listTop: number;
  /** 记录时间（epoch ms）：只保留最近使用领域的现场。 */
  at: number;
}

const KEY = "paper-field.domain-spot";
/** 最多记住多少个领域的现场：超出按最久未用裁剪。 */
const SPOT_LIMIT = 12;

function isSpot(value: unknown): value is DomainSpot {
  if (!value || typeof value !== "object") return false;
  const spot = value as Partial<DomainSpot>;
  return (
    typeof spot.search === "string" &&
    (spot.paperId === null || typeof spot.paperId === "string") &&
    typeof spot.listTop === "number" &&
    Number.isFinite(spot.listTop) &&
    spot.listTop >= 0 &&
    typeof spot.at === "number" &&
    Number.isFinite(spot.at)
  );
}

/** 读取全部领域现场；localStorage 不可用或损坏时返回空表。 */
export function loadDomainSpots(): Record<string, DomainSpot> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return {};
    const spots: Record<string, DomainSpot> = {};
    for (const [domainId, spot] of Object.entries(value as Record<string, unknown>)) {
      if (isSpot(spot)) spots[domainId] = spot;
    }
    return spots;
  } catch {
    return {};
  }
}

function persist(spots: Record<string, DomainSpot>): void {
  try {
    if (typeof localStorage === "undefined") return;
    const ids = Object.keys(spots);
    if (ids.length) localStorage.setItem(KEY, JSON.stringify(spots));
    else localStorage.removeItem(KEY);
  } catch {
    // 存不下（隐私模式等）：本次会话内仍由 store 内存状态兜底。
  }
}

/** 记录一个领域的现场；超过上限时裁掉最久未用的。 */
export function saveDomainSpot(domainId: string, spot: DomainSpot): void {
  if (!domainId || !isSpot(spot)) return;
  const spots = loadDomainSpots();
  spots[domainId] = spot;
  const ids = Object.keys(spots);
  if (ids.length > SPOT_LIMIT) {
    for (const id of ids.sort((a, b) => spots[a].at - spots[b].at).slice(0, ids.length - SPOT_LIMIT)) {
      delete spots[id];
    }
  }
  persist(spots);
}

/** 读单个领域的现场（没有则 undefined）。 */
export function domainSpotOf(domainId: string): DomainSpot | undefined {
  return loadDomainSpots()[domainId];
}

/** 清掉一个领域的现场（供「清空条件」与测试使用）。 */
export function clearDomainSpot(domainId: string): void {
  const spots = loadDomainSpots();
  if (!(domainId in spots)) return;
  delete spots[domainId];
  persist(spots);
}
