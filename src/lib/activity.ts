// 作业实况：llm_jobs 表只记录「哪个作业、什么状态」，这里补上只有运行时才知道的细节——
// - 批次：一次导入 / 重试 / 补全提交了哪些论文、正在处理第几篇、逐篇结果与耗时；
// - 作业：当前处于哪一阶段（提交 / 解析 / 取回全文 / 请求模型 / 写入结果）、何时进入、
//   用的哪个解析源、官方 API 回报的页进度；
// - 本次会话的完成 / 失败 / 取消计数。
// 仅存内存：重启即清空，与 repo.init 把残留作业清扫为「应用上次退出」的语义一致。
// 状态整体不可变（每次变化换新对象），useSyncExternalStore 可直接以 getActivity 作 getSnapshot。
// 本模块不发通知、不写日志：通知与日志仍由 mineruRun / store 的既有收口负责。

export type BatchKind = "mineru" | "meta";
export type BatchItemResult = "ok" | "fail" | "cancelled" | "skip";
/** waiting = 已入链等待前序批次；halted = 连续失败熔断或异常中止，剩余论文未处理。 */
export type BatchState = "waiting" | "running" | "done" | "halted";
/** MinerU：submit → parse → fetch；AI：queue → request → apply。 */
export type JobStage = "queue" | "submit" | "parse" | "fetch" | "request" | "apply";
export type JobOutcome = "done" | "error" | "cancelled";

export interface ActivityBatch {
  id: number;
  kind: BatchKind;
  paperIds: string[];
  results: Record<string, BatchItemResult>;
  currentPaperId: string | null;
  /** 当前论文开始处理的时间（epoch 毫秒）。 */
  currentStartedAt: number | null;
  /** 已处理各篇的耗时（毫秒，不含跳过），供估算剩余时间。 */
  durations: number[];
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  state: BatchState;
}

export interface PageProgress {
  done: number;
  total: number;
}

export interface JobLive {
  jobId: string;
  paperId: string;
  stage: JobStage;
  /** 进入当前阶段的时间（epoch 毫秒）；阶段不变时的补丁不重置。 */
  stageAt: number;
  /** MinerU 实际使用的解析源；提交前为 null（由后端按回退顺序选择）。 */
  provider: string | null;
  /** 页进度：仅官方 API 回报（extracted_pages / total_pages）。 */
  pages: PageProgress | null;
  /** 解析完成后的自动补全等静默作业。 */
  auto: boolean;
}

export interface SessionTally {
  done: number;
  failed: number;
  cancelled: number;
}

export interface ActivityState {
  /** 旧 → 新；含等待、运行中与最近结束的批次。 */
  batches: ActivityBatch[];
  jobs: Record<string, JobLive>;
  tally: SessionTally;
  /** 本次会话开始时间（epoch 毫秒）。 */
  sessionStartedAt: number;
}

/** 已结束批次只保留最近几个：面板只展示最近一批的结果小结。 */
export const FINISHED_BATCH_LIMIT = 3;

function initial(): ActivityState {
  return {
    batches: [],
    jobs: {},
    tally: { done: 0, failed: 0, cancelled: 0 },
    sessionStartedAt: Date.now(),
  };
}

let state: ActivityState = initial();
let nextBatchId = 1;
const listeners = new Set<() => void>();

/** 订阅实况变化；返回退订函数。 */
export function subscribeActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 当前实况快照（不可变；未变化时返回同一引用）。 */
export function getActivity(): ActivityState {
  return state;
}

function commit(next: ActivityState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function mapBatch(id: number, update: (batch: ActivityBatch) => ActivityBatch): void {
  if (!state.batches.some((batch) => batch.id === id)) return;
  commit({ ...state, batches: state.batches.map((batch) => (batch.id === id ? update(batch) : batch)) });
}

function pruneFinished(batches: ActivityBatch[]): ActivityBatch[] {
  const finished = batches.filter((batch) => batch.state === "done" || batch.state === "halted");
  if (finished.length <= FINISHED_BATCH_LIMIT) return batches;
  const drop = new Set(finished.slice(0, finished.length - FINISHED_BATCH_LIMIT).map((batch) => batch.id));
  return batches.filter((batch) => !drop.has(batch.id));
}

// ---------- 批次 ----------

/** 登记一个等待中的批次（入链即登记，前序批次跑完前就能在面板里看到排队论文）。 */
export function queueBatch(kind: BatchKind, paperIds: string[]): number {
  const id = nextBatchId;
  nextBatchId += 1;
  const batch: ActivityBatch = {
    id,
    kind,
    paperIds: [...new Set(paperIds)],
    results: {},
    currentPaperId: null,
    currentStartedAt: null,
    durations: [],
    queuedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    state: "waiting",
  };
  commit({ ...state, batches: [...state.batches, batch] });
  return id;
}

export function startBatch(id: number): void {
  mapBatch(id, (batch) => ({ ...batch, state: "running", startedAt: batch.startedAt ?? Date.now() }));
}

export function beginBatchItem(id: number, paperId: string): void {
  mapBatch(id, (batch) => ({ ...batch, currentPaperId: paperId, currentStartedAt: Date.now() }));
}

export function endBatchItem(id: number, paperId: string, result: BatchItemResult): void {
  mapBatch(id, (batch) => {
    const elapsed =
      batch.currentPaperId === paperId && batch.currentStartedAt !== null
        ? Date.now() - batch.currentStartedAt
        : null;
    return {
      ...batch,
      results: { ...batch.results, [paperId]: result },
      currentPaperId: batch.currentPaperId === paperId ? null : batch.currentPaperId,
      currentStartedAt: batch.currentPaperId === paperId ? null : batch.currentStartedAt,
      durations: elapsed !== null && result !== "skip" ? [...batch.durations, elapsed] : batch.durations,
    };
  });
}

export function finishBatch(id: number, outcome: "done" | "halted"): void {
  if (!state.batches.some((batch) => batch.id === id)) return;
  const batches = state.batches.map((batch) =>
    batch.id === id
      ? { ...batch, state: outcome, currentPaperId: null, currentStartedAt: null, finishedAt: Date.now() }
      : batch,
  );
  commit({ ...state, batches: pruneFinished(batches) });
}

/** 批次未真正开始就作废（如解析源已全部停用）：直接移除，不留结果小结。 */
export function discardBatch(id: number): void {
  if (!state.batches.some((batch) => batch.id === id)) return;
  commit({ ...state, batches: state.batches.filter((batch) => batch.id !== id) });
}

// ---------- 作业 ----------

/** 登记或推进一个作业的阶段；阶段未变时只合并补丁，不重置阶段计时。 */
export function trackJob(
  jobId: string,
  paperId: string,
  stage: JobStage,
  extra: Partial<Pick<JobLive, "provider" | "pages" | "auto">> = {},
): void {
  const prev = state.jobs[jobId];
  const sameStage = prev?.stage === stage;
  const next: JobLive = {
    jobId,
    paperId,
    stage,
    stageAt: sameStage && prev ? prev.stageAt : Date.now(),
    provider: extra.provider !== undefined ? extra.provider : prev?.provider ?? null,
    pages: extra.pages !== undefined ? extra.pages : sameStage ? prev?.pages ?? null : null,
    auto: extra.auto ?? prev?.auto ?? false,
  };
  commit({ ...state, jobs: { ...state.jobs, [jobId]: next } });
}

/** 合并补丁（解析源 / 页进度），不改阶段；未登记的作业忽略。 */
export function patchJobLive(jobId: string, patch: Partial<Pick<JobLive, "provider" | "pages">>): void {
  const prev = state.jobs[jobId];
  if (!prev) return;
  const next = { ...prev, ...patch };
  if (next.provider === prev.provider && samePages(next.pages, prev.pages)) return;
  commit({ ...state, jobs: { ...state.jobs, [jobId]: next } });
}

/** 作业结束：移出实况并计入本次会话计数（同一作业只计一次）。 */
export function endJob(jobId: string, outcome: JobOutcome): void {
  if (!state.jobs[jobId]) return;
  const jobs = { ...state.jobs };
  delete jobs[jobId];
  const tally = { ...state.tally };
  if (outcome === "done") tally.done += 1;
  else if (outcome === "error") tally.failed += 1;
  else tally.cancelled += 1;
  commit({ ...state, jobs, tally });
}

function samePages(a: PageProgress | null, b: PageProgress | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.done === b.done && a.total === b.total;
}

/**
 * 汇总 MinerU 轮询回报的页进度（每项形如 "3/10"，doclib 为 null）。
 * 多个解析项按页数求和；总页数未知（全为 null 或 0）时返回 null。
 */
export function parsePageProgress(values: Array<string | null | undefined>): PageProgress | null {
  let done = 0;
  let total = 0;
  for (const value of values) {
    const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(value ?? "");
    if (!match) continue;
    done += Number(match[1]);
    total += Number(match[2]);
  }
  if (total <= 0) return null;
  return { done: Math.min(done, total), total };
}

/** 测试专用：清空全部实况。 */
export function resetActivity(): void {
  nextBatchId = 1;
  commit(initial());
}
