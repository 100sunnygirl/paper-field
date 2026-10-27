/**
 * 每篇论文的阅读现场（本机 localStorage 记忆，跨会话保留）：
 * - top：阅读滚动容器 .ef-read-scroll 的滚动位置
 * - section：离开时所在区段锚点（abstract / fulltext / ft-sec-N / note-*），
 *   重新打开时目录据此高亮
 * - fulltextOpen：解析全文折叠区是否展开
 * 坏数据（缺字段 / 类型不对）整条丢弃，不影响其他论文。
 */

export interface ReadingSpot {
  top: number;
  section: string;
  fulltextOpen: boolean;
  /** 记录时间（epoch ms）：只保留最近阅读的若干篇。 */
  at: number;
}

const KEY = "paper-field.reading-spot";
/** 最多记住多少篇论文的现场：超出按最久未读裁剪，避免 localStorage 无界增长。 */
const SPOT_LIMIT = 50;

function isSpot(value: unknown): value is ReadingSpot {
  if (!value || typeof value !== "object") return false;
  const spot = value as Partial<ReadingSpot>;
  return (
    typeof spot.top === "number" &&
    Number.isFinite(spot.top) &&
    spot.top >= 0 &&
    typeof spot.section === "string" &&
    spot.section.length > 0 &&
    typeof spot.fulltextOpen === "boolean" &&
    typeof spot.at === "number" &&
    Number.isFinite(spot.at)
  );
}

/** 读取全部阅读现场；localStorage 不可用或损坏时返回空表。 */
export function loadReadingSpots(): Record<string, ReadingSpot> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return {};
    const spots: Record<string, ReadingSpot> = {};
    for (const [paperId, spot] of Object.entries(value as Record<string, unknown>)) {
      if (isSpot(spot)) spots[paperId] = spot;
    }
    return spots;
  } catch {
    return {};
  }
}

function persist(spots: Record<string, ReadingSpot>): void {
  try {
    if (typeof localStorage === "undefined") return;
    const ids = Object.keys(spots);
    if (ids.length) localStorage.setItem(KEY, JSON.stringify(spots));
    else localStorage.removeItem(KEY);
  } catch {
    // 存不下（隐私模式等）：本会话的现场仍由组件内存记忆。
  }
}

/** 记录一篇论文的阅读现场；超过上限时裁掉最久未读的条目。 */
export function saveReadingSpot(paperId: string, spot: ReadingSpot): void {
  if (!paperId || !isSpot(spot)) return;
  const spots = loadReadingSpots();
  spots[paperId] = spot;
  const ids = Object.keys(spots);
  if (ids.length > SPOT_LIMIT) {
    for (const id of ids.sort((a, b) => spots[a].at - spots[b].at).slice(0, ids.length - SPOT_LIMIT)) {
      delete spots[id];
    }
  }
  persist(spots);
}

/** 清掉一篇论文的现场（目前供测试与坏数据清理使用）。 */
export function clearReadingSpot(paperId: string): void {
  const spots = loadReadingSpots();
  if (!(paperId in spots)) return;
  delete spots[paperId];
  persist(spots);
}
