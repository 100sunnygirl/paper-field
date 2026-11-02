// 作业面板的视图模型：把 llm_jobs（持久状态）与 activity（运行时实况）合成为
// 「进行中 / 本批进度 / 排队 / 最近完成」四块。纯函数、不读时钟（now 由调用方传入），便于测试。
import type { ActivityBatch, ActivityState, BatchItemResult, BatchKind, JobLive, JobStage, PageProgress } from "./activity";
import { JOB_TYPE_LABELS, MINERU_PROVIDER_LABELS, type JobType, type LlmJob, type PaperBrief } from "./types";
import { pad2 } from "./util";

export type StepState = "done" | "current" | "todo";

export interface StageStep {
  key: JobStage;
  label: string;
  state: StepState;
}

export interface ActiveJobView {
  id: string;
  type: JobType;
  typeLabel: string;
  status: "queued" | "running";
  paperId: string;
  domainId: string | null;
  title: string;
  domainName: string | null;
  steps: StageStep[];
  stage: JobStage;
  /** 当前阶段的一句话说明（只写真实状态）。 */
  stageHint: string;
  /** 作业总用时（自开始运行；排队中自创建）。 */
  elapsedMs: number;
  /** 当前阶段用时；无实况时为 null。 */
  stageElapsedMs: number | null;
  provider: string | null;
  pages: PageProgress | null;
  auto: boolean;
  /** 所属批次关联（本批第几篇 / 共几篇）：面板进行中卡与入库页作业行同一口径。 */
  batch: { index: number; total: number } | null;
}

export type SegmentState = BatchItemResult | "current" | "pending" | "paused";

export interface BatchSegment {
  paperId: string;
  title: string;
  state: SegmentState;
  /** 失败原因（该篇最近一次失败作业的 error）；其余状态为 null。 */
  note: string | null;
}

export interface BatchView {
  id: number;
  kind: BatchKind;
  label: string;
  state: ActivityBatch["state"];
  total: number;
  /** 已有结果的篇数（含失败 / 取消 / 跳过）。 */
  processed: number;
  ok: number;
  fail: number;
  cancelled: number;
  skipped: number;
  /** 尚未开始的篇数（不含正在处理的一篇）。 */
  pending: number;
  percent: number;
  segments: BatchSegment[];
  currentPaperId: string | null;
  elapsedMs: number;
  /** 按已完成各篇平均耗时估算的剩余时间；无样本或已结束时为 null。 */
  etaMs: number | null;
  /**
   * 剩余时间估算的置信信息：样本篇数、按最快 / 最慢各篇推得的区间，
   * 以及估算偏不确定的原因（当前篇远超均值 / 各篇耗时差异大，可能切换过解析源）。
   */
  etaInfo: { samples: number; lowMs: number; highMs: number; caveat: "current" | "spread" | null } | null;
  finishedAt: number | null;
}

export interface QueueItemView {
  paperId: string;
  domainId: string | null;
  title: string;
  domainName: string | null;
  batchId: number;
  kind: BatchKind;
  /** 所在批次仍在等待前序批次（尚未开始）。 */
  waiting: boolean;
}

export interface HistoryItemView {
  id: string;
  type: JobType;
  typeLabel: string;
  status: "done" | "error" | "cancelled";
  paperId: string;
  domainId: string | null;
  title: string;
  domainName: string | null;
  durationMs: number | null;
  finishedAt: string | null;
  /** 面向用户的结果说明（失败原因 / 取消原因）；成功为 null。 */
  note: string | null;
  /** 可在面板里直接重新解析：该篇最近一次 MinerU 作业失败或被取消，且当前没有进行中的作业。 */
  retryable: boolean;
  /**
   * 可在面板里直接重试的 AI 作业类型（该篇该类型最近一次失败 / 被取消，且没有进行中的作业）。
   * 重试入口一律 overwrite=false：手改字段与笔记由 meta_rev / user_edited 锁保护，不覆盖。
   */
  aiRetry: "prepareMeta" | "draftNotes" | "refreshLinks" | null;
}

export interface JobsView {
  active: ActiveJobView[];
  /** 运行中的批次；没有时为最近结束的一批（结果小结）。 */
  batch: BatchView | null;
  waitingBatches: { count: number; papers: number };
  queue: QueueItemView[];
  history: HistoryItemView[];
  counts: { running: number; queued: number; done: number; failed: number; cancelled: number };
  busy: boolean;
}

export const BATCH_LABELS: Record<BatchKind, string> = {
  mineru: "MinerU 解析",
  meta: "AI 补全",
};

const MINERU_STEPS: Array<{ key: JobStage; label: string }> = [
  { key: "submit", label: "提交" },
  { key: "parse", label: "解析" },
  { key: "fetch", label: "取回全文" },
];

const AI_STEPS: Array<{ key: JobStage; label: string }> = [
  { key: "queue", label: "排队" },
  { key: "request", label: "请求模型" },
  { key: "apply", label: "写入结果" },
];

/** 最近完成列表的条数上限。 */
export const HISTORY_LIMIT = 12;

export function stepsFor(type: JobType, stage: JobStage): StageStep[] {
  const steps = type === "mineruParse" ? MINERU_STEPS : AI_STEPS;
  const index = Math.max(0, steps.findIndex((step) => step.key === stage));
  return steps.map((step, i) => ({
    ...step,
    state: i < index ? "done" : i === index ? "current" : "todo",
  }));
}

export function providerName(provider: string | null | undefined): string | null {
  if (!provider) return null;
  return MINERU_PROVIDER_LABELS[provider] ?? provider;
}

function stageHint(type: JobType, stage: JobStage, provider: string | null, pages: PageProgress | null): string {
  switch (stage) {
    case "submit":
      return provider ? `上传 PDF 并提交到${provider}` : "按回退顺序选择解析源并上传 PDF";
    case "parse":
      return pages
        ? `已解析 ${pages.done} / ${pages.total} 页`
        : `${provider ?? "解析源"}正在解析，每 4 秒检查一次`;
    case "fetch":
      return "下载解析结果并写入全文";
    case "queue":
      return "等待开始";
    case "request":
      return "等待模型返回结构化结果";
    case "apply":
      return type === "draftNotes" ? "写入阅读笔记" : "写入论文信息";
    default:
      return "";
  }
}

function inferStage(job: Pick<LlmJob, "type" | "status">): JobStage {
  if (job.type === "mineruParse") return "submit";
  return job.status === "queued" ? "queue" : "request";
}

/**
 * 入库页作业行与作业面板共用的阶段一句话（同一口径）：实况补阶段 / 解析源 / 页进度，
 * 无实况时按作业类型与状态推断。
 */
export function jobStageLine(
  type: JobType,
  status: LlmJob["status"],
  live?: Pick<JobLive, "stage" | "provider" | "pages"> | null,
): string {
  return stageHint(type, live?.stage ?? inferStage({ type, status }), providerName(live?.provider), live?.pages ?? null);
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

/** 无标题时的兜底：论文编号前 4 位（与列表短码同口径）。 */
function fallbackTitle(paperId: string): string {
  return `论文 ${paperId.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
}

interface Lookup {
  title: string;
  domainId: string | null;
  domainName: string | null;
}

function makeLookup(jobs: LlmJob[], briefs: Record<string, PaperBrief>) {
  const fromJobs = new Map<string, Lookup>();
  for (const job of jobs) {
    if (fromJobs.has(job.paperId) || !job.paperTitle) continue;
    fromJobs.set(job.paperId, {
      title: job.paperTitleZh || job.paperTitle,
      domainId: job.domainId ?? null,
      domainName: job.domainName ?? null,
    });
  }
  return (paperId: string): Lookup => {
    const brief = briefs[paperId];
    if (brief) {
      return { title: brief.titleZh || brief.title, domainId: brief.domainId, domainName: brief.domainName };
    }
    return fromJobs.get(paperId) ?? { title: fallbackTitle(paperId), domainId: null, domainName: null };
  };
}

function historyNote(job: LlmJob): string | null {
  if (job.status === "done") return null;
  if (job.status === "cancelled") {
    return job.error === "replaced" ? "已被新的解析作业替换" : "已取消";
  }
  return job.error?.trim() || "未知错误";
}

function batchView(
  batch: ActivityBatch,
  lookup: (id: string) => Lookup,
  now: number,
  errorByPaper: Map<string, string>,
): BatchView {
  let ok = 0;
  let fail = 0;
  let cancelled = 0;
  let skipped = 0;
  const finished = batch.state === "done" || batch.state === "halted";
  const segments: BatchSegment[] = batch.paperIds.map((paperId) => {
    const result = batch.results[paperId];
    if (result === "ok") ok += 1;
    else if (result === "fail") fail += 1;
    else if (result === "cancelled") cancelled += 1;
    else if (result === "skip") skipped += 1;
    const state: SegmentState = result
      ? result
      : batch.currentPaperId === paperId
        ? "current"
        : finished
          ? "paused"
          : "pending";
    return {
      paperId,
      title: lookup(paperId).title,
      state,
      note: result === "fail" ? errorByPaper.get(paperId) ?? null : null,
    };
  });
  const total = batch.paperIds.length;
  const processed = ok + fail + cancelled + skipped;
  const pending = segments.filter((segment) => segment.state === "pending").length;
  const started = batch.startedAt ?? batch.queuedAt;
  const elapsedMs = Math.max(0, (batch.finishedAt ?? now) - started);
  let etaMs: number | null = null;
  let etaInfo: BatchView["etaInfo"] = null;
  if (!finished && batch.durations.length) {
    const avg = batch.durations.reduce((sum, value) => sum + value, 0) / batch.durations.length;
    const fastest = Math.min(...batch.durations);
    const slowest = Math.max(...batch.durations);
    const currentElapsed = batch.currentStartedAt !== null ? now - batch.currentStartedAt : 0;
    const currentLeft = batch.currentPaperId ? Math.max(0, avg - currentElapsed) : 0;
    etaMs = Math.round(currentLeft + avg * pending);
    // 区间按最快 / 最慢各篇推：少量样本时均值显得过度确定，区间更诚实。
    const leftBy = (per: number) => Math.max(0, per - currentElapsed) + per * pending;
    etaInfo = {
      samples: batch.durations.length,
      lowMs: Math.round(batch.currentPaperId ? leftBy(fastest) : fastest * pending),
      highMs: Math.round(batch.currentPaperId ? leftBy(slowest) : slowest * pending),
      caveat:
        batch.currentPaperId && currentElapsed > avg * 2
          ? "current"
          : batch.durations.length >= 2 && slowest > fastest * 3
            ? "spread"
            : null,
    };
  }
  return {
    id: batch.id,
    kind: batch.kind,
    label: BATCH_LABELS[batch.kind],
    state: batch.state,
    total,
    processed,
    ok,
    fail,
    cancelled,
    skipped,
    pending,
    percent: total ? Math.round((processed / total) * 100) : 0,
    segments,
    currentPaperId: batch.currentPaperId,
    elapsedMs,
    etaMs,
    etaInfo,
    finishedAt: batch.finishedAt,
  };
}

export function deriveJobsView(input: {
  jobs: LlmJob[];
  activity: ActivityState;
  briefs?: Record<string, PaperBrief>;
  now: number;
}): JobsView {
  const { jobs, activity, now } = input;
  const lookup = makeLookup(jobs, input.briefs ?? {});

  // 进行中：以持久状态为准（取消后立即离场），实况只补阶段与进度。运行中在前，同状态先到先列。
  const activeJobs = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "running" ? -1 : 1;
      return (ms(a.startedAt) ?? ms(a.createdAt) ?? 0) - (ms(b.startedAt) ?? ms(b.createdAt) ?? 0);
    });
  const active: ActiveJobView[] = activeJobs.map((job) => {
    const live = activity.jobs[job.id];
    const stage = live?.stage ?? inferStage(job);
    const provider = providerName(live?.provider);
    const pages = live?.pages ?? null;
    const info = lookup(job.paperId);
    const since = job.status === "running" ? ms(job.startedAt) ?? ms(job.createdAt) : ms(job.createdAt);
    // 所属批次：正在处理这篇、或这篇还没轮到的批次（运行中的优先）。
    const ownBatch = activity.batches.find(
      (batch) =>
        (batch.state === "running" || batch.state === "waiting") &&
        batch.paperIds.includes(job.paperId) &&
        (batch.currentPaperId === job.paperId || !batch.results[job.paperId]),
    );
    const index = ownBatch ? ownBatch.paperIds.indexOf(job.paperId) : -1;
    return {
      id: job.id,
      type: job.type,
      typeLabel: JOB_TYPE_LABELS[job.type],
      status: job.status as "queued" | "running",
      paperId: job.paperId,
      domainId: info.domainId,
      title: info.title,
      domainName: info.domainName,
      steps: stepsFor(job.type, stage),
      stage,
      stageHint: stageHint(job.type, stage, provider, pages),
      elapsedMs: since === null ? 0 : Math.max(0, now - since),
      stageElapsedMs: live ? Math.max(0, now - live.stageAt) : null,
      provider,
      pages,
      auto: live?.auto ?? false,
      batch: index >= 0 ? { index: index + 1, total: ownBatch!.paperIds.length } : null,
    };
  });
  const activePaperIds = new Set(active.map((job) => job.paperId));

  const running = activity.batches.find((batch) => batch.state === "running") ?? null;
  const waiting = activity.batches.filter((batch) => batch.state === "waiting");
  const lastFinished = [...activity.batches]
    .reverse()
    .find((batch) => batch.state === "done" || batch.state === "halted");
  const shown = running ?? lastFinished ?? null;

  // 排队：运行中批次里尚未开始的论文 + 等待中批次的全部论文；同一篇只列一次，已有进行中作业的不重复列。
  const queue: QueueItemView[] = [];
  const seen = new Set<string>();
  const enqueue = (batch: ActivityBatch, waitingBatch: boolean) => {
    for (const paperId of batch.paperIds) {
      if (batch.results[paperId] || batch.currentPaperId === paperId) continue;
      if (seen.has(paperId) || activePaperIds.has(paperId)) continue;
      seen.add(paperId);
      const info = lookup(paperId);
      queue.push({
        paperId,
        domainId: info.domainId,
        title: info.title,
        domainName: info.domainName,
        batchId: batch.id,
        kind: batch.kind,
        waiting: waitingBatch,
      });
    }
  };
  if (running) enqueue(running, false);
  waiting.forEach((batch) => enqueue(batch, true));

  // 每篇论文最近一次 MinerU 作业（按创建时间）：只有它失败 / 被取消时才提供「重新解析」。
  const latestMineru = new Map<string, LlmJob>();
  // 每篇论文每个类型的最近一次作业：AI 类（补全 / 起草 / 刷新链接）失败或被取消时可就地重试。
  const latestOfType = new Map<string, LlmJob>();
  // 逐篇失败原因（该篇最近一次失败作业的 error）：批次色块 / 列表视图展示用。
  const errorByPaper = new Map<string, string>();
  const errorAt = new Map<string, number>();
  for (const job of jobs) {
    if (job.status === "error" && job.error) {
      const at = ms(job.createdAt) ?? 0;
      if (at >= (errorAt.get(job.paperId) ?? -1)) {
        errorAt.set(job.paperId, at);
        errorByPaper.set(job.paperId, job.error);
      }
    }
    if (job.type === "mineruParse") {
      const prev = latestMineru.get(job.paperId);
      if (!prev || (ms(job.createdAt) ?? 0) > (ms(prev.createdAt) ?? 0)) latestMineru.set(job.paperId, job);
    }
    const key = `${job.paperId}:${job.type}`;
    const prev = latestOfType.get(key);
    if (!prev || (ms(job.createdAt) ?? 0) > (ms(prev.createdAt) ?? 0)) latestOfType.set(key, job);
  }

  const history: HistoryItemView[] = jobs
    .filter((job) => job.status === "done" || job.status === "error" || job.status === "cancelled")
    .sort((a, b) => (ms(b.finishedAt) ?? ms(b.createdAt) ?? 0) - (ms(a.finishedAt) ?? ms(a.createdAt) ?? 0))
    .slice(0, HISTORY_LIMIT)
    .map((job) => {
      const info = lookup(job.paperId);
      const start = ms(job.startedAt) ?? ms(job.createdAt);
      const end = ms(job.finishedAt);
      const latestOfKind = latestOfType.get(`${job.paperId}:${job.type}`);
      return {
        id: job.id,
        type: job.type,
        typeLabel: JOB_TYPE_LABELS[job.type],
        status: job.status as HistoryItemView["status"],
        paperId: job.paperId,
        domainId: info.domainId,
        title: info.title,
        domainName: info.domainName,
        durationMs: start !== null && end !== null ? Math.max(0, end - start) : null,
        finishedAt: job.finishedAt,
        note: historyNote(job),
        retryable:
          job.type === "mineruParse" &&
          latestMineru.get(job.paperId)?.id === job.id &&
          (job.status === "error" || (job.status === "cancelled" && job.error !== "replaced")) &&
          !activePaperIds.has(job.paperId) &&
          !seen.has(job.paperId) &&
          running?.currentPaperId !== job.paperId,
        aiRetry:
          job.type !== "mineruParse" &&
          (job.status === "error" || (job.status === "cancelled" && job.error !== "replaced")) &&
          latestOfKind?.id === job.id &&
          !activePaperIds.has(job.paperId)
            ? (job.type as HistoryItemView["aiRetry"])
            : null,
      };
    });

  const runningCount = active.filter((job) => job.status === "running").length;
  const queuedCount = active.filter((job) => job.status === "queued").length + queue.length;
  return {
    active,
    batch: shown ? batchView(shown, lookup, now, errorByPaper) : null,
    waitingBatches: {
      count: waiting.length,
      papers: waiting.reduce((sum, batch) => sum + batch.paperIds.length, 0),
    },
    queue,
    history,
    counts: {
      running: runningCount,
      queued: queuedCount,
      done: activity.tally.done,
      failed: activity.tally.failed,
      cancelled: activity.tally.cancelled,
    },
    busy: active.length > 0 || Boolean(running) || waiting.length > 0,
  };
}

/** 计时显示：mm:ss，满一小时为 h:mm:ss。 */
export function formatElapsed(msValue: number): string {
  const total = Math.max(0, Math.floor(msValue / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(minutes)}:${pad2(seconds)}`;
}

/**
 * 排队论文的领域分布（折叠处的一句话概览）：按领域计数、取前 max 个，
 * 形如「多模态 18 · 指令对齐 5 · 其他 2」。没有论文时返回 null。
 */
export function summarizeDomains(items: Array<{ domainName: string | null }>, max = 3): string | null {
  if (!items.length) return null;
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = item.domainName?.trim() || "未分领域";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"));
  const shown = ranked.slice(0, max);
  const rest = ranked.slice(max).reduce((sum, [, count]) => sum + count, 0);
  const parts = shown.map(([name, count]) => `${name} ${count}`);
  if (rest > 0) parts.push(`其他 ${rest}`);
  return parts.join(" · ");
}

/** 已结束作业的用时：口语化写法，避免与「结束时刻」的时:分混淆。 */
export function formatSpan(msValue: number): string {
  const total = Math.max(0, Math.round(msValue / 1000));
  if (total < 60) return `${total} 秒`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

/** 剩余时间估算的口语化写法（估算值不给秒级精度）。 */
export function formatEta(msValue: number): string {
  const seconds = Math.round(msValue / 1000);
  if (seconds < 60) return "不到 1 分钟";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `约 ${hours} 小时 ${rest} 分钟` : `约 ${hours} 小时`;
}

/** 完成时刻：今天只给时分，其余日期带月日。 */
export function formatClock(iso: string | null, now: number): string {
  const value = ms(iso);
  if (value === null) return "—";
  const d = new Date(value);
  const today = new Date(now);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.toDateString() === today.toDateString() ? hm : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}
