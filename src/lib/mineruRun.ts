import {
  mineruCurrentFingerprint,
  mineruMarkdown,
  mineruParseStatuses,
  mineruSubmit,
  type MineruSettingsV2,
} from "./mineru";
import type { MineruProviderKind } from "./types";
import {
  beginBatchItem,
  discardBatch,
  endBatchItem,
  finishBatch,
  getActivity,
  parsePageProgress,
  patchJobLive,
  queueBatch,
  startBatch,
  type BatchItemResult,
} from "./activity";
import { cancelJob, cancelJobsForPapers, JobCancelled, liveJobsFor, runTracked, type JobCtx } from "./jobs";
import { log } from "./logger";
import { repo } from "./repo";
import { nowIso } from "./util";

interface Host {
  mineru: () => MineruSettingsV2;
  hasKey: () => boolean;
  refresh: () => Promise<void>;
  flash: (tone: "ok" | "warn" | "error", text: string) => void;
  prepare: (paperId: string, overwrite: boolean, quiet: boolean) => Promise<void>;
}

/**
 * 「移出队列 / 停止本批」按批次记：`${batchId}:${paperId}`。只影响那一批，
 * 用户随后点「重新解析」发起的新批次不受它影响；已经在跑的那一篇由作业取消处理。
 */
const dequeued = new Set<string>();
const queueKey = (batchId: number, paperId: string) => `${batchId}:${paperId}`;

// 两条互不阻塞的串行链：MinerU 解析（提交 / 轮询 / 取全文）与 AI 补全（含回填）。
let mineruChain: Promise<void> = Promise.resolve();
let metaChain: Promise<void> = Promise.resolve();
let backfillQueued = false;

const timing = { pollMs: 4000, retryMs: 2000 };

/** 测试用：缩短轮询与重试间隔。 */
export function setMineruTiming(next: Partial<typeof timing>): void {
  Object.assign(timing, next);
}

export const STALE_CRED_ERROR = "设置已变或升级缺指纹，请重新解析";

async function resumeAllowed(paper: {
  mineruStatus: string | null;
  mineruCredFingerprint: string | null;
  mineruProvider: string | null;
  mineruDocRef: string | null;
}): Promise<boolean> {
  if (paper.mineruStatus !== "submitted" && paper.mineruStatus !== "parsing") return false;
  if (!paper.mineruCredFingerprint || !paper.mineruProvider || !paper.mineruDocRef) return false;
  try {
    const current = await mineruCurrentFingerprint(paper.mineruProvider as MineruProviderKind);
    return current === paper.mineruCredFingerprint;
  } catch {
    return false;
  }
}

/** 作业面板「移出队列」：这一批轮到这篇时直接跳过，库里状态改成已取消。 */
export async function dequeueFromBatch(batchId: number, paperId: string): Promise<void> {
  dequeued.add(queueKey(batchId, paperId));
  endBatchItem(batchId, paperId, "cancelled");
  await repo.setMineruState(paperId, { status: "cancelled" });
}

/**
 * 停止一批（解析或 AI 补全）：还没轮到的全部移出；正在处理的那一篇有作业就取消作业，
 * 还没建作业就打上移出标记（建好作业后会立刻看到并自行取消）。返回停止的篇数。
 */
export async function stopBatch(batchId: number): Promise<number> {
  const batch = getActivity().batches.find((item) => item.id === batchId);
  if (!batch) return 0;
  const pending = batch.paperIds.filter((id) => !batch.results[id] && id !== batch.currentPaperId);
  for (const id of pending) {
    if (batch.kind === "mineru") await dequeueFromBatch(batchId, id);
    else {
      dequeued.add(queueKey(batchId, id));
      endBatchItem(batchId, id, "cancelled");
    }
  }
  let stopped = pending.length;
  const current = batch.currentPaperId;
  if (current) {
    dequeued.add(queueKey(batchId, current));
    for (const jobId of liveJobsFor(current, batch.kind === "mineru" ? "mineruParse" : "prepareMeta")) {
      await cancelJob(jobId);
    }
    stopped += 1;
  }
  return stopped;
}

function enqueueOn(which: "mineru" | "meta", task: () => Promise<void>): void {
  const run = (chain: Promise<void>) =>
    chain.then(task).catch((err: unknown) => {
      // 后台任务链在此终结错误：这里曾是全应用唯一无痕的错误路径，必须留日志。
      log.error(which === "mineru" ? "mineru" : "llm", "后台任务异常退出", err);
    });
  if (which === "mineru") mineruChain = run(mineruChain);
  else metaChain = run(metaChain);
}

export function enqueueMineru(task: () => Promise<void>): void {
  enqueueOn("mineru", task);
}

export function enqueueMeta(task: () => Promise<void>): void {
  enqueueOn("meta", task);
}

/** 回填只排一份：已有一份在等待时不再重复入链（保存设置、启动都会触发回填）。 */
export function enqueueBackfill(host: Host): void {
  if (backfillQueued) return;
  backfillQueued = true;
  enqueueMeta(async () => {
    backfillQueued = false;
    await backfillMeta(host);
  });
}

/**
 * 入链一个解析批次，并立即在作业实况里登记为「等待」：
 * 前序批次还在跑时，作业面板就能列出这批排队的论文。
 */
export function enqueueMineruBatch(host: Host, paperIds: string[], force = false): void {
  const batchId = queueBatch("mineru", paperIds);
  enqueueMineru(() => runMineruBatch(host, paperIds, force, batchId));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** 每一步网络等待前后都检查：本机取消、移出队列、所有权被收回（重新解析 / 删除论文）。 */
async function checkpoint(ctx: JobCtx, batchId: number | undefined): Promise<void> {
  if (ctx.signal.aborted) throw new JobCancelled();
  if (batchId !== undefined && dequeued.has(queueKey(batchId, ctx.paperId))) throw new JobCancelled();
  if (!(await repo.ownsMineru(ctx.paperId, ctx.jobId))) throw new JobCancelled();
}

async function pollMarkdown(
  host: Host,
  ctx: JobCtx,
  batchId: number | undefined,
  provider: MineruProviderKind,
  docRef: string,
  parseIds: string[],
  tier: string,
  pageRange: string,
  expectedFingerprint: string,
): Promise<string> {
  const deadline = Date.now() + 45 * 60 * 1000;
  let announced = false;
  while (Date.now() < deadline) {
    await checkpoint(ctx, batchId);
    if (!announced) {
      await repo.setMineruState(ctx.paperId, { status: "parsing" }, ctx.jobId);
      await host.refresh();
      announced = true;
    }
    // 「无 parseIds 直接取 markdown」仅对 doclib 成立；官方 API 的 parseIds 恒为空，
    // 必须先轮询 batch 状态等到 done 再取 full.md，否则会在 running 阶段过早取结果。
    if (!parseIds.length && provider !== "api") {
      ctx.stage("fetch");
      return mineruMarkdown(provider, docRef, tier, pageRange, ctx.paperId, expectedFingerprint);
    }
    const polls = await pollStatuses(provider, docRef, parseIds, ctx.paperId, expectedFingerprint);
    patchJobLive(ctx.jobId, { pages: parsePageProgress(polls.map((item) => item.progress)) });
    const waiting = polls.some((item) => item.status === "pending" || item.status === "parsing");
    const failed = polls.find((item) => item.status === "failed");
    const settled = polls.some((item) => item.status === "done" || item.status === "superseded");
    if (!waiting && failed && !settled) {
      throw new Error(failed.error || "MinerU 解析失败");
    }
    if (!waiting) {
      // 轮询返回期间可能已被取消：取全文前再查一次，免得白白下载。
      await checkpoint(ctx, batchId);
      ctx.stage("fetch");
      return mineruMarkdown(provider, docRef, tier, pageRange, ctx.paperId, expectedFingerprint);
    }
    await sleep(timing.pollMs);
  }
  throw new Error("MinerU 解析超时");
}

async function pollStatuses(
  provider: MineruProviderKind,
  docRef: string,
  parseIds: string[],
  paperId: string,
  expectedFingerprint: string,
) {
  let last: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await mineruParseStatuses(provider, docRef, parseIds, paperId, expectedFingerprint);
    } catch (err) {
      last = err;
      await sleep(timing.retryMs);
    }
  }
  const detail = last instanceof Error ? last.message : String(last);
  // 恢复/轮询仅同源：源级错误不自动换源（short_id 与 batch_id 命名空间不同），
  // 指引用户点「重新解析」由后端按回退顺序重选源重新提交。
  throw new Error(`解析源不可用（${detail}）。可点击重新解析换源重提。`);
}

/**
 * 解析完成后的自动元数据补全（跑在 AI 队列上，不挡后面的解析）。
 * 关键语义：overwrite=false —— 自动补全永不覆盖用户手改过的字段；quiet=true 避免 flash 刷屏。
 */
async function autoPrepare(host: Host, paperId: string): Promise<BatchItemResult> {
  if (!host.hasKey()) return "skip";
  const paper = await repo.getPaper(paperId);
  if (!paper || paper.llmPreparedAt || !paper.parsedMarkdown.trim()) return "skip";
  await host.prepare(paperId, false, true);
  const after = await repo.getPaper(paperId);
  return after?.llmPreparedAt ? "ok" : "fail";
}

/**
 * 全文、解析状态与作业结束在同一个事务里：作业已被取消或所有权已被收回时整批不写，
 * 不会出现「解析完成但没有全文」或「取消之后又被标成完成」。
 */
async function commitParseSuccess(ctx: JobCtx, markdown: string): Promise<boolean> {
  const at = nowIso();
  return repo.finishJob(ctx.jobId, "done", {
    steps: [
      {
        sql: `INSERT INTO paper_parse (paper_id, markdown, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(paper_id) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at`,
        params: [ctx.paperId, markdown, at],
      },
      {
        sql: `UPDATE papers SET mineru_status = 'done', mineru_error = NULL, updated_at = ?
               WHERE id = ? AND mineru_job_id = ? AND mineru_status IN ('queued','submitted','parsing')`,
        params: [at, ctx.paperId, ctx.jobId],
        expect: "one",
      },
    ],
  });
}

function parseErrorSteps(paperId: string) {
  return (jobId: string, message: string) => [
    {
      sql: `UPDATE papers SET mineru_status = 'error', mineru_error = ?, updated_at = ?
             WHERE id = ? AND mineru_job_id = ?`,
      params: [message, nowIso(), paperId, jobId],
    },
  ];
}

async function processOne(
  host: Host,
  paperId: string,
  force: boolean,
  batchId?: number,
): Promise<BatchItemResult> {
  const paper = await repo.getPaper(paperId);
  if (!paper?.pdfPath) return "skip";
  if (batchId !== undefined && dequeued.has(queueKey(batchId, paperId))) return "cancelled";
  if (paper.mineruStatus === "done" && paper.parsedMarkdown.trim()) {
    enqueueMeta(async () => void (await autoPrepare(host, paperId)));
    return "ok";
  }
  const settings = host.mineru();
  if (!settings.configured) return "skip";

  const inflight = paper.mineruStatus === "submitted" || paper.mineruStatus === "parsing";
  if (!force && inflight && !(await resumeAllowed(paper))) {
    await repo.setMineruState(paperId, { status: "error", error: STALE_CRED_ERROR });
    await host.refresh();
    return "fail";
  }
  // 恢复仅同源：pending 论文必须带有提交时记录的 provider 才能续轮询；
  // 旧数据（status=submitted 但无 provider）只能重新提交，由后端按 order 重选源。
  const canResume = !force && inflight && Boolean(paper.mineruDocRef) && Boolean(paper.mineruProvider);
  // 同一篇论文只留一个解析作业：先取消之前的（本机在跑的与库里残留的）。
  const previous = await repo.activeJobIds([paperId]);
  for (const job of previous.filter((item) => item.type === "mineruParse")) await cancelJob(job.id, job);
  // 上面的等待（指纹核对、取消旧作业）期间可能已被停止或删除（forgetPapers 会打移出标记）：
  // 建作业前再核对一次，否则删掉的论文让认领失败、整批中断。停止的篇记为已取消。
  if (batchId !== undefined && dequeued.has(queueKey(batchId, paperId))) {
    await repo.setMineruState(paperId, { status: "cancelled" });
    return "cancelled";
  }

  const result = await runTracked(
    {
      type: "mineruParse",
      paperId,
      prompt: paper.pdfPath,
      stage: canResume ? "parse" : "submit",
      provider: canResume ? paper.mineruProvider : null,
      claimMineru: { resume: canResume },
      errorSteps: parseErrorSteps(paperId),
    },
    async (ctx) => {
      let docRef = paper.mineruDocRef;
      let parseIds = paper.mineruParseIds;
      let provider = paper.mineruProvider as MineruProviderKind | null;
      let expectedFingerprint = paper.mineruCredFingerprint ?? "";
      await host.refresh();
      if (!canResume) {
        await checkpoint(ctx, batchId);
        const submitted = await mineruSubmit(paperId, paper.pdfPath!, force);
        await checkpoint(ctx, batchId);
        docRef = submitted.shortId;
        parseIds = submitted.parseIds;
        provider = submitted.provider;
        expectedFingerprint = submitted.credFingerprint;
        const claimed = await repo.setMineruState(
          paperId,
          {
            status: "submitted",
            parseId: parseIds[0] ?? null,
            parseIds,
            docRef,
            provider,
            error: null,
            credFingerprint: expectedFingerprint,
          },
          ctx.jobId,
        );
        if (!claimed) throw new JobCancelled();
        await host.refresh();
        ctx.stage(submitted.status === "done" ? "fetch" : "parse", { provider });
        if (submitted.status === "done") {
          const markdown = await mineruMarkdown(
            provider,
            docRef,
            submitted.tier || settings.tier,
            settings.pageRange,
            paperId,
            expectedFingerprint,
          );
          await checkpoint(ctx, batchId);
          return (await commitParseSuccess(ctx, markdown)) ? "done" : "cancelled";
        }
      }
      if (!docRef || !provider) throw new Error("MinerU 没有返回文档编号");
      const markdown = await pollMarkdown(
        host,
        ctx,
        batchId,
        provider,
        docRef,
        parseIds,
        settings.tier,
        settings.pageRange,
        expectedFingerprint,
      );
      await checkpoint(ctx, batchId);
      return (await commitParseSuccess(ctx, markdown)) ? "done" : "cancelled";
    },
  );
  await host.refresh();
  if (result.outcome === "done") {
    enqueueMeta(async () => void (await autoPrepare(host, paperId)));
    return "ok";
  }
  if (result.outcome === "cancelled") return "cancelled";
  log.error("mineru", `论文解析失败（${paperId}）`, result.error);
  return "fail";
}

/** 连续失败达到该值即熔断剩余批次：解析源大概率繁忙或不可用，继续只会逐篇耗时超时。 */
const CONSECUTIVE_FAIL_LIMIT = 3;

export const PAUSED_ERROR = "连续失败已暂停，可在 INTAKE 页重试";

/**
 * 熔断后剩余的论文写成 error（带暂停原因），让「重试解析失败」能看到它们；
 * 已移出的不计数，也不改已经结束的论文。返回真正被暂停的篇数。
 */
async function pauseRemaining(batchId: number, paperIds: string[]): Promise<number> {
  let paused = 0;
  for (const paperId of paperIds) {
    if (dequeued.has(queueKey(batchId, paperId))) continue;
    const paper = await repo.getPaper(paperId);
    if (!paper?.pdfPath) continue;
    const status = paper.mineruStatus;
    if (status !== null && status !== "pending" && status !== "queued" && status !== "submitted" && status !== "parsing") continue;
    await repo.setMineruState(paperId, { status: "error", error: PAUSED_ERROR, jobId: null });
    paused += 1;
  }
  return paused;
}

export async function runMineruBatch(
  host: Host,
  paperIds: string[],
  force = false,
  /** enqueueMineruBatch 入链时预登记的批次；直接调用（如启动恢复）时现场登记。 */
  batchId?: number,
): Promise<void> {
  // 守卫语义：order 中无任何启用源 → 静默返回（入口 importPdfs/retryMineru 已给出指引）。
  if (!host.mineru().configured) {
    if (batchId !== undefined) discardBatch(batchId);
    return;
  }
  const id = batchId ?? queueBatch("mineru", paperIds);
  startBatch(id);
  // 正常走完记 done；熔断提前返回或意外抛错记 halted（剩余论文在面板上显示为已暂停）。
  let state: "done" | "halted" = "halted";
  try {
    log.info("mineru", `解析批次开始：共 ${paperIds.length} 篇`);
    let ok = 0;
    let fail = 0;
    let consecutiveFails = 0;
    let pausedCount = 0;
    for (const [index, paperId] of paperIds.entries()) {
      if (consecutiveFails >= CONSECUTIVE_FAIL_LIMIT) {
        pausedCount = await pauseRemaining(id, paperIds.slice(index));
        break;
      }
      // 作业面板「移出队列」的论文：轮到时直接出列，不在面板上闪一下「处理中」；
      // 库里状态在出列时已写成 cancelled，重启或保存设置后不会被自动重新提交。
      if (dequeued.has(queueKey(id, paperId))) {
        endBatchItem(id, paperId, "cancelled");
        continue;
      }
      beginBatchItem(id, paperId);
      const result = await processOne(host, paperId, force, id);
      endBatchItem(id, paperId, result);
      if (result === "ok") {
        ok += 1;
        consecutiveFails = 0;
      } else if (result === "fail") {
        fail += 1;
        consecutiveFails += 1;
      }
      // cancelled / skip 不计入连续失败，也不打断计数。
    }
    if (pausedCount) {
      log.warn("mineru", `连续失败 ${consecutiveFails} 篇，熔断暂停剩余 ${pausedCount} 篇`);
      host.flash(
        "error",
        `MinerU 解析连续失败 ${consecutiveFails} 篇，已暂停剩余 ${pausedCount} 篇。解析源可能繁忙或不可用，可在设置页测试连接，稍后在 INTAKE 页重试。`,
      );
      return;
    }
    state = "done";
    log.info("mineru", `解析批次结束：成功 ${ok} 篇，失败 ${fail} 篇`);
    if (fail) {
      host.flash("error", `MinerU 解析失败 ${fail} 篇，可在资料栏重试。`);
    } else if (ok && !host.hasKey()) {
      host.flash("warn", "解析完成。尚未配置 AI，书目仍使用文件名，可稍后补全。");
    } else if (ok) {
      host.flash("ok", `MinerU 解析完成 ${ok} 篇。阅读状态未改动。`);
    }
  } finally {
    for (const paperId of paperIds) dequeued.delete(queueKey(id, paperId));
    finishBatch(id, state);
  }
}

export async function resumeMineru(host: Host): Promise<void> {
  if (!host.mineru().configured) return;
  const pending = await repo.listPendingMineru();
  const runnable: string[] = [];
  let stale = 0;
  for (const id of pending) {
    const paper = await repo.getPaper(id);
    if (!paper) continue;
    const inflight = paper.mineruStatus === "submitted" || paper.mineruStatus === "parsing";
    if (inflight && !(await resumeAllowed(paper))) {
      await repo.setMineruState(id, { status: "error", error: STALE_CRED_ERROR });
      stale += 1;
      continue;
    }
    runnable.push(id);
  }
  if (stale) {
    await host.refresh();
    host.flash("error", STALE_CRED_ERROR);
  }
  if (runnable.length) {
    host.flash("ok", "继续上次未完成的解析。");
    await runMineruBatch(host, runnable, false);
  }
  if (host.hasKey()) enqueueBackfill(host);
}

/** AI 回填连续失败达到该值即暂停：多半是 Key 错了或本地模型没启动。 */
const META_FAIL_LIMIT = 3;

export async function backfillMeta(host: Host): Promise<void> {
  if (!host.hasKey()) return;
  const ids = await repo.listReadyForMeta();
  if (!ids.length) return;
  const batchId = queueBatch("meta", ids);
  startBatch(batchId);
  let state: "done" | "halted" = "halted";
  let filled = 0;
  let consecutiveFails = 0;
  try {
    for (const id of ids) {
      if (dequeued.has(queueKey(batchId, id))) {
        endBatchItem(batchId, id, "cancelled");
        continue;
      }
      if (consecutiveFails >= META_FAIL_LIMIT) {
        host.flash(
          "error",
          `AI 补全连续失败 ${consecutiveFails} 篇，已暂停剩余论文。请在设置页检查 AI 服务（Key、地址、模型），之后保存设置会再试一次。`,
        );
        return;
      }
      beginBatchItem(batchId, id);
      const result = await autoPrepare(host, id);
      endBatchItem(batchId, id, result);
      if (result === "ok") {
        filled += 1;
        consecutiveFails = 0;
      } else if (result === "fail") {
        consecutiveFails += 1;
      }
    }
    state = "done";
  } finally {
    for (const id of ids) dequeued.delete(queueKey(batchId, id));
    finishBatch(batchId, state);
  }
  if (filled) host.flash("ok", `已为 ${filled} 篇论文补全信息。阅读状态未改动。`);
}

/** 删除论文前调用：取消它们的在途作业并从所有等待中的批次里移出。 */
export async function forgetPapers(paperIds: string[]): Promise<void> {
  for (const batch of getActivity().batches) {
    if (batch.state !== "waiting" && batch.state !== "running") continue;
    for (const paperId of paperIds) {
      if (batch.paperIds.includes(paperId) && !batch.results[paperId]) {
        dequeued.add(queueKey(batch.id, paperId));
        if (batch.currentPaperId !== paperId) endBatchItem(batch.id, paperId, "cancelled");
      }
    }
  }
  await cancelJobsForPapers(paperIds);
}

/** 重新解析前取消这些论文正在跑的解析作业（本机与库里残留的），其他类型的作业不动。 */
export async function cancelParses(paperIds: string[]): Promise<void> {
  const rows = await repo.activeJobIds(paperIds);
  for (const row of rows.filter((item) => item.type === "mineruParse")) await cancelJob(row.id, row);
}
