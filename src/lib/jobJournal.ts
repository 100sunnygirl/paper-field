// 本机批次记录（localStorage 键 paper-field.job-journal）。
//
// 为什么在 SQLite 之外另存一份：llm_jobs 只记「哪个作业、什么状态」，批次（一次导入 /
// 重试 / 补全提交了哪些论文、逐篇结果、何时开始结束）只存在内存 activity 里，重启即清空。
// 批次表本可以进 schema v7，但桌面端 restore.rs 的 SCHEMA_VERSION 与 schema.ts 锁步同步
// （Rust 侧拒绝恢复 user_version 更新的备份），前端单方面升版本会破坏桌面端恢复链路，
// 因此诚实缩小范围：批次记录存在本机浏览器存储——重启可回看、可导出，但不随备份走，
// 换机 / 恢复备份后没有这部分记录；逐篇作业明细仍以库里的 llm_jobs 为准。
// 阶段与页进度不做定期落库（重启后续跑语义已由 mineru 状态列 + resumeMineru 覆盖）。
import { nowIso } from "./util";

export type JobJournalKind = "mineru" | "meta";
export type JobJournalState = "running" | "done" | "halted" | "interrupted";

export interface JobJournalEntry {
  id: string;
  kind: JobJournalKind;
  state: JobJournalState;
  paperIds: string[];
  /** 逐篇结果（paperId → ok / fail / cancelled / skip），处理到哪记到哪。 */
  results: Record<string, string>;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

const KEY = "paper-field.job-journal";
/** 最多保留的批次数（写入时裁剪，控制 localStorage 体积）。 */
const JOURNAL_LIMIT = 60;

function read(): JobJournalEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(isEntry);
  } catch {
    return [];
  }
}

function isEntry(value: unknown): value is JobJournalEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<JobJournalEntry>;
  return (
    typeof entry.id === "string" &&
    (entry.kind === "mineru" || entry.kind === "meta") &&
    Array.isArray(entry.paperIds) &&
    typeof entry.queuedAt === "number"
  );
}

function write(entries: JobJournalEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-JOURNAL_LIMIT)));
  } catch {
    // 存不下（隐私模式 / 超配额）不影响批处理：记录只留在本次会话的调用栈里。
  }
}

/** 批次开始（或恢复续跑的批次重新开始）时登记；返回记录 id。 */
export function journalBegin(kind: JobJournalKind, paperIds: string[]): string {
  const id = `jb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  write([...read(), { id, kind, state: "running", paperIds: [...paperIds], results: {}, queuedAt: Date.now(), startedAt: Date.now(), finishedAt: null }]);
  return id;
}

/** 逐篇结果落账（endBatchItem 的同时调用；未知 id 忽略）。 */
export function journalItem(journalId: string, paperId: string, result: string): void {
  const entries = read();
  const entry = entries.find((item) => item.id === journalId);
  if (!entry) return;
  entry.results = { ...entry.results, [paperId]: result };
  write(entries);
}

/** 批次收尾：done（跑完）/ halted（熔断或用户暂停）。 */
export function journalFinish(journalId: string, state: "done" | "halted"): void {
  const entries = read();
  const entry = entries.find((item) => item.id === journalId);
  if (!entry) return;
  entry.state = state;
  entry.finishedAt = Date.now();
  write(entries);
}

/**
 * 最近 `sinceDays` 天的批次记录（新 → 旧）。上一会话还没写终态的 running 记录
 * 显示为「应用退出中断」（与 repo.init 把残留 llm_jobs 清扫为中断错误同一口径）。
 */
export function listJobBatches(sinceDays = 7): JobJournalEntry[] {
  const since = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  return read()
    .filter((entry) => entry.queuedAt >= since)
    .reverse()
    .map((entry) => (entry.state === "running" ? { ...entry, state: "interrupted" as const } : entry));
}

/** 有「应用退出中断」的记录（面板据此给一句口径解释）。 */
export function hasInterruptedBatches(sinceDays = 7): boolean {
  return listJobBatches(sinceDays).some((entry) => entry.state === "interrupted");
}

/** 把记录导出为一段纯文本（含逐篇结果计数与起止时间）。 */
export function exportJobJournal(entries: JobJournalEntry[]): string {
  const lines = entries.map((entry) => {
    const counts = countResults(entry.results);
    const started = entry.startedAt ? new Date(entry.startedAt).toLocaleString() : "—";
    const finished = entry.finishedAt ? new Date(entry.finishedAt).toLocaleString() : "（未收尾）";
    return [
      `- ${entry.kind === "mineru" ? "MinerU 解析" : "AI 补全"} · ${JOURNAL_STATE_LABELS[entry.state]}`,
      `  提交 ${entry.paperIds.length} 篇 · 成功 ${counts.ok} · 失败 ${counts.fail} · 取消 ${counts.cancelled} · 跳过 ${counts.skip}`,
      `  开始 ${started} · 结束 ${finished}`,
    ].join("\n");
  });
  return [
    "# paper-field 本机批次记录",
    `导出时间：${nowIso()}`,
    "口径说明：批次记录保存在本机浏览器存储，不随备份走；逐篇作业明细以库内 llm_jobs 为准，「应用退出中断」与启动清扫口径一致。",
    "",
    ...lines,
  ].join("\n");
}

export const JOURNAL_STATE_LABELS: Record<JobJournalState, string> = {
  running: "进行中",
  done: "已完成",
  halted: "已暂停",
  interrupted: "应用退出中断",
};

function countResults(results: Record<string, string>): { ok: number; fail: number; cancelled: number; skip: number } {
  let ok = 0;
  let fail = 0;
  let cancelled = 0;
  let skip = 0;
  for (const result of Object.values(results)) {
    if (result === "ok") ok += 1;
    else if (result === "fail") fail += 1;
    else if (result === "cancelled") cancelled += 1;
    else if (result === "skip") skip += 1;
  }
  return { ok, fail, cancelled, skip };
}

/** 测试专用：清空记录。 */
export function resetJobJournal(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
