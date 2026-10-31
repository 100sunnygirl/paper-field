import type { PaperListItem } from "./types";

/**
 * 归档「阅读成果回顾」的本机统计：本周 / 本月 / 今年已读、连续阅读天数、
 * 最常读领域与今年逐月分布。全部由归档列表的 readAt 派生，纯函数、无 IO。
 *
 * 口径（诚实优先）：
 * - 本周从周一起算、本月从 1 日起算、今年从 1 月 1 日起算（本地时区）；
 * - 连续阅读按「有论文标记为已读的自然日」连串：今天还没读不断串（从昨天起算），
 *   一旦出现空档即止；没有任何记录为 0 天；
 * - 没有 readAt 的已读论文（旧库极少数）不参与时间统计。
 */

export interface ReadingStats {
  /** 本周（周一起）标记已读的篇数。 */
  week: number;
  /** 本月（1 日起）标记已读的篇数。 */
  month: number;
  /** 今年标记已读的篇数。 */
  year: number;
  /** 连续阅读天数（今天或昨天收尾的连续自然日）。 */
  streak: number;
  /** 今年读得最多的领域名（今年无已读为 null）。 */
  topDomain: string | null;
  /** 今年 1–12 月逐月已读篇数（下标 0 = 一月）。 */
  months: number[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** 本地时区自然日键（YYYY-M-D，不补零：只做集合比对）。 */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function readingStatsFrom(items: PaperListItem[], now: Date = new Date()): ReadingStats {
  const today = startOfDay(now);
  const weekStart = new Date(today.getTime() - ((today.getDay() + 6) % 7) * DAY_MS);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const yearStart = new Date(today.getFullYear(), 0, 1);

  let week = 0;
  let month = 0;
  let year = 0;
  const months = new Array<number>(12).fill(0);
  const dayKeys = new Set<string>();
  const domainCounts = new Map<string, number>();

  for (const item of items) {
    if (!item.readAt) continue;
    const at = new Date(item.readAt);
    if (Number.isNaN(at.getTime())) continue;
    const day = startOfDay(at);
    if (day >= weekStart) week += 1;
    if (day >= monthStart) month += 1;
    if (day >= yearStart) {
      year += 1;
      months[at.getMonth()] += 1;
      const name = item.domainName || item.domainCode || "未命名领域";
      domainCounts.set(name, (domainCounts.get(name) ?? 0) + 1);
    }
    dayKeys.add(dayKey(day));
  }

  let streak = 0;
  const cursor = new Date(today);
  // 今天还没读不打断连串：从昨天起算；昨天也没读即为 0。
  if (!dayKeys.has(dayKey(cursor))) cursor.setTime(cursor.getTime() - DAY_MS);
  while (dayKeys.has(dayKey(cursor))) {
    streak += 1;
    cursor.setTime(cursor.getTime() - DAY_MS);
  }

  let topDomain: string | null = null;
  let topCount = 0;
  for (const [name, count] of domainCounts) {
    if (count > topCount) {
      topDomain = name;
      topCount = count;
    }
  }

  return { week, month, year, streak, topDomain, months };
}

const DISMISS_KEY = "paper-field.archive-stats-dismissed";

/** 用户关闭过统计卡（本机记住）。 */
export function isArchiveStatsDismissed(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function setArchiveStatsDismissed(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // 存不下（隐私模式等）：本次会话仍可用内存态隐藏，下次进入恢复显示。
  }
}
