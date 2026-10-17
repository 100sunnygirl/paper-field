// 作业的唯一生命周期管理：建作业、登记取消句柄、推进实况阶段、落到终态。
// 作业状态以 llm_jobs 为准；这里只多存一份「本进程里正在跑的作业」以便取消时能打断它
// （AbortController + 可选的取消钩子，如通知 Rust 侧中止模型请求）。
// 任何出口（正常结束、取消、出错、意外抛错）都经 runTracked 的 finally 收尾：
// 实况一定移除、本次会话计数一定计入，不会再有「作业行早已结束、面板还挂着」的情况。

import type { BatchStep } from "./engine";
import { endJob, trackJob, type JobOutcome, type JobStage } from "./activity";
import { log } from "./logger";
import { repo } from "./repo";
import type { JobType } from "./types";

/** 作业被取消（用户取消、论文被删、所有权被收回）：不是错误，以 cancelled 收场。 */
export class JobCancelled extends Error {
  constructor() {
    super("CANCELLED");
    this.name = "JobCancelled";
  }
}

interface LiveJob {
  paperId: string;
  type: JobType;
  controller: AbortController;
  /** 取消时额外要做的事（如 llm_cancel 中止 Rust 侧的模型请求）。 */
  onCancel?: (jobId: string) => Promise<void>;
}

const live = new Map<string, LiveJob>();

/** 取消一个解析作业时，论文的解析状态一并改成已取消（只在它仍归这次作业所有时）。 */
function mineruCancelSteps(jobId: string, paperId: string): BatchStep[] {
  return [
    {
      sql: `UPDATE papers SET mineru_status = 'cancelled', updated_at = ?
             WHERE id = ? AND mineru_job_id = ? AND mineru_status IN ('pending','queued','submitted','parsing')`,
      params: [new Date().toISOString(), paperId, jobId],
    },
  ];
}

export interface JobCtx {
  jobId: string;
  paperId: string;
  signal: AbortSignal;
  /** 被取消（本机取消或作业行已不在 running）时抛 JobCancelled。 */
  checkpoint(): Promise<void>;
  /** 推进作业面板上的阶段。 */
  stage(stage: JobStage, extra?: Parameters<typeof trackJob>[3]): void;
}

export interface TrackedOptions {
  type: JobType;
  paperId: string;
  prompt: string | null;
  stage: JobStage;
  auto?: boolean;
  provider?: string | null;
  claimMineru?: { resume: boolean };
  onCancel?: (jobId: string) => Promise<void>;
  /** 出错时随作业一起落库的数据（如把论文的解析状态改成失败）。 */
  errorSteps?: (jobId: string, message: string) => BatchStep[];
}

export interface TrackedResult {
  jobId: string;
  outcome: JobOutcome;
  error: string | null;
}

/**
 * 跑一个作业。body 正常结束时必须已经用 repo.finishJob（或带 jobDoneStep 的写入）把作业落到 done，
 * 并返回 "done"；落库前提不成立（作业已被取消、所有权已被收回）则返回 "cancelled"。
 * body 返回 "cancelled"、抛 JobCancelled 或在取消后抛错，都按取消收场；其他错误把作业记为失败。
 */
export async function runTracked(
  options: TrackedOptions,
  body: (ctx: JobCtx) => Promise<"done" | "cancelled">,
): Promise<TrackedResult> {
  const job = await repo.startJob(options.paperId, options.type, options.prompt, options.claimMineru);
  const controller = new AbortController();
  live.set(job.id, { paperId: options.paperId, type: options.type, controller, onCancel: options.onCancel });
  trackJob(job.id, options.paperId, options.stage, {
    auto: options.auto ?? false,
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
  });
  let outcome: JobOutcome = "error";
  let error: string | null = null;
  // AI 作业逐个留日志（解析作业由批次日志覆盖，不再逐篇刷）。
  const aiJob = options.type !== "mineruParse";
  if (aiJob) log.info("llm", `AI 作业开始（${job.id}）`);
  const ctx: JobCtx = {
    jobId: job.id,
    paperId: options.paperId,
    signal: controller.signal,
    async checkpoint() {
      if (controller.signal.aborted) throw new JobCancelled();
      if ((await repo.jobStatus(job.id)) !== "running") throw new JobCancelled();
    },
    stage(stage, extra) {
      trackJob(job.id, options.paperId, stage, extra);
    },
  };
  // 以取消收场时作业行一定落到 cancelled（已是终态则不动）；解析作业同 cancelJob，
  // 论文仍归这次作业且在途时一并改成已取消，不会留下续跑时又被捡起的 queued/submitted。
  const finishCancelled = () =>
    repo.finishJob(job.id, "cancelled", {
      error: "cancelled",
      steps: options.type === "mineruParse" ? mineruCancelSteps(job.id, options.paperId) : [],
    });
  try {
    outcome = await body(ctx);
    if (aiJob && outcome === "done") log.info("llm", `AI 作业完成（${job.id}）`);
    // body 落库失败返回 cancelled 不一定是作业已被取消（也可能是所有权被收回），作业行不能挂在 running。
    if (outcome === "cancelled") await finishCancelled();
    return { jobId: job.id, outcome, error: null };
  } catch (err) {
    if (err instanceof JobCancelled || controller.signal.aborted) {
      outcome = "cancelled";
      await finishCancelled();
      return { jobId: job.id, outcome, error: null };
    }
    error = err instanceof Error ? err.message : String(err);
    const marked = await repo.finishJob(job.id, "error", {
      error,
      steps: options.errorSteps?.(job.id, error) ?? [],
    });
    // 落库时作业已被取消：以取消收场，不报失败。
    outcome = marked ? "error" : "cancelled";
    if (aiJob && marked) log.error("llm", `AI 作业失败（${job.id}）`, error);
    return { jobId: job.id, outcome, error: marked ? error : null };
  } finally {
    live.delete(job.id);
    endJob(job.id, outcome);
  }
}

/** 与数据写入放进同一个 batch 的「作业 → done」：作业已不在 running 时整批回滚。 */
export function jobDoneStep(jobId: string, resultJson: string | null = null): BatchStep {
  return {
    sql: `UPDATE llm_jobs SET status = 'done', result_json = COALESCE(?, result_json), finished_at = ?
           WHERE id = ? AND status = 'running'`,
    params: [resultJson, new Date().toISOString(), jobId],
    expect: "one",
  };
}

/** 取消一个作业：打断本机的执行，作业行与解析状态落到已取消。 */
export async function cancelJob(jobId: string, known?: { paperId: string; type: JobType }): Promise<void> {
  const entry = live.get(jobId);
  const paperId = entry?.paperId ?? known?.paperId;
  const type = entry?.type ?? known?.type;
  entry?.controller.abort();
  if (entry?.onCancel) await entry.onCancel(jobId).catch(() => undefined);
  await repo.finishJob(jobId, "cancelled", {
    error: "cancelled",
    steps: type === "mineruParse" && paperId ? mineruCancelSteps(jobId, paperId) : [],
  });
}

/** 取消这些论文的全部在途作业（删除论文 / 领域前调用），本机与库里的都算。 */
export async function cancelJobsForPapers(paperIds: string[]): Promise<void> {
  const ids = new Set(paperIds);
  const seen = new Set<string>();
  for (const [jobId, entry] of live) {
    if (!ids.has(entry.paperId)) continue;
    seen.add(jobId);
    await cancelJob(jobId);
  }
  for (const row of await repo.activeJobIds(paperIds)) {
    if (!seen.has(row.id)) await cancelJob(row.id, row);
  }
}

/** 本进程里这篇论文正在跑的作业（可按类型筛）。 */
export function liveJobsFor(paperId: string, type?: JobType): string[] {
  return [...live.entries()]
    .filter(([, entry]) => entry.paperId === paperId && (!type || entry.type === type))
    .map(([jobId]) => jobId);
}

/** 测试用：清空登记表。 */
export function resetLiveJobs(): void {
  live.clear();
}
