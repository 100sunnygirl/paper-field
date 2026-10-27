/**
 * 「在读起点」的本机记录（localStorage）：
 * 库里没有 reading_status 的变更时间戳（updated_at 会被任何编辑覆盖），
 * 所以从本功能上线起，状态改为「在读」的时刻由前端在本机记一笔；
 * 更早就在读的论文 / 换机器的场景回落论文入库时间（createdAt）估算，
 * 界面用「入库第 N 天」的措辞诚实区分。
 *
 * 语义：
 * - 改为「在读」：没有记录就记现在；已有记录保留（在读→已读→再在读
 *   视为同一段阅读，不重置天数）。
 * - 改为「未读」：清除记录（明确宣告不在读；再次在读重新起算）。
 * - 改为「已读」：保留记录。
 */

const KEY = "paper-field.reading-since";
/** 上限：超过时按最早的起点裁剪（在读起点很老的记录价值最低）。 */
const LIMIT = 200;

function load(): Record<string, string> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return {};
    const records: Record<string, string> = {};
    for (const [paperId, iso] of Object.entries(value as Record<string, unknown>)) {
      if (typeof iso === "string" && !Number.isNaN(new Date(iso).getTime())) records[paperId] = iso;
    }
    return records;
  } catch {
    return {};
  }
}

function persist(records: Record<string, string>): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (Object.keys(records).length) localStorage.setItem(KEY, JSON.stringify(records));
    else localStorage.removeItem(KEY);
  } catch {
    // 存不下（隐私模式等）：本会话内仍可读内存……此处为纯函数模块，存不下就丢，
    // 下一次状态变更会再尝试。
  }
}

/** 阅读状态变化时记账（由 store.setReadingStatus 在写库成功后调用）。 */
export function noteReadingStatus(paperId: string, status: "unread" | "reading" | "read", now = Date.now()): void {
  if (!paperId) return;
  const records = load();
  if (status === "unread") {
    if (!(paperId in records)) return;
    delete records[paperId];
  } else if (status === "reading") {
    if (records[paperId]) return;
    records[paperId] = new Date(now).toISOString();
  } else {
    return; // 已读保留记录
  }
  const ids = Object.keys(records);
  if (ids.length > LIMIT) {
    for (const id of ids.sort((a, b) => records[a].localeCompare(records[b])).slice(0, ids.length - LIMIT)) {
      delete records[id];
    }
  }
  persist(records);
}

/** 这篇论文本机记录的「在读起点」；没有记录返回 null。 */
export function readingSinceFor(paperId: string): string | null {
  return load()[paperId] ?? null;
}

/**
 * 第 N 天：起点当天是第 1 天（与「在读第 3 天」的自然语义一致）。
 * 时间解析失败返回 null（调用方回落其他措辞）。
 */
export function daysInto(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const start = new Date(iso).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(1, Math.floor((now - start) / 86_400_000) + 1);
}
