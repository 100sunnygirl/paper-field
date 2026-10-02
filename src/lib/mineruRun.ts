import {
  mineruMarkdown,
  mineruParseStatuses,
  mineruSubmit,
  type MineruSettingsV2,
} from "./mineru";
import type { MineruProviderKind } from "./types";
import { repo } from "./repo";
import { nowIso } from "./util";

interface Host {
  mineru: () => MineruSettingsV2;
  hasKey: () => boolean;
  refresh: () => Promise<void>;
  flash: (tone: "ok" | "warn" | "error", text: string) => void;
  prepare: (paperId: string, overwrite: boolean, quiet: boolean) => Promise<void>;
}

const cancelled = new Set<string>();
let chain: Promise<void> = Promise.resolve();

export function cancelMineruPaper(paperId: string): void {
  cancelled.add(paperId);
}

export function clearMineruCancel(paperId: string): void {
  cancelled.delete(paperId);
}

export function enqueueMineru(task: () => Promise<void>): void {
  chain = chain.then(task).catch((err: unknown) => {
    console.error(err);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function retireActive(paperId: string): Promise<void> {
  const jobs = await repo.listJobs(80);
  for (const job of jobs) {
    if (job.paperId === paperId && job.type === "mineruParse" && (job.status === "queued" || job.status === "running")) {
      await repo.updateJob(job.id, { status: "cancelled", error: "replaced", finishedAt: nowIso() });
    }
  }
}

async function pollMarkdown(
  host: Host,
  paperId: string,
  provider: MineruProviderKind,
  docRef: string,
  parseIds: string[],
  tier: string,
  pageRange: string,
): Promise<string> {
  const deadline = Date.now() + 45 * 60 * 1000;
  let announced = false;
  while (Date.now() < deadline) {
    if (cancelled.has(paperId)) throw new Error("CANCELLED");
    if (!announced) {
      await repo.setMineruState(paperId, { status: "parsing" });
      await host.refresh();
      announced = true;
    }
    // 「无 parseIds 直接取 markdown」仅对 doclib 成立；官方 API 的 parseIds 恒为空，
    // 必须先轮询 batch 状态等到 done 再取 full.md，否则会在 running 阶段过早取结果。
    if (!parseIds.length && provider !== "api") {
      return mineruMarkdown(provider, docRef, tier, pageRange);
    }
    const polls = await pollStatuses(provider, docRef, parseIds);
    const waiting = polls.some((item) => item.status === "pending" || item.status === "parsing");
    const failed = polls.find((item) => item.status === "failed");
    const settled = polls.some((item) => item.status === "done" || item.status === "superseded");
    if (!waiting && failed && !settled) {
      throw new Error(failed.error || "MinerU 解析失败");
    }
    if (!waiting) {
      return mineruMarkdown(provider, docRef, tier, pageRange);
    }
    await sleep(4000);
  }
  throw new Error("MinerU 解析超时");
}

async function pollStatuses(provider: MineruProviderKind, docRef: string, parseIds: string[]) {
  let last: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await mineruParseStatuses(provider, docRef, parseIds);
    } catch (err) {
      last = err;
      await sleep(2000);
    }
  }
  const detail = last instanceof Error ? last.message : String(last);
  // 恢复/轮询仅同源：源级错误不自动换源（short_id 与 batch_id 命名空间不同），
  // 指引用户点「重新解析」由后端按回退顺序重选源重新提交。
  throw new Error(`解析源不可用（${detail}）。可点击重新解析换源重提。`);
}

/**
 * 解析完成后的自动元数据补全（曾因函数体丢失成为死链）。
 * 关键语义：overwrite=false —— repo.applyPreparedMeta 的用户编辑锁生效，
 * 自动补全永不覆盖用户手改过的字段；quiet=true 避免 flash 刷屏。
 */
async function autoPrepare(host: Host, paperId: string): Promise<boolean> {
  if (!host.hasKey()) return false;
  const paper = await repo.getPaper(paperId);
  if (!paper || paper.llmPreparedAt || !paper.parsedMarkdown.trim()) return false;
  await host.prepare(paperId, false, true);
  const after = await repo.getPaper(paperId);
  return Boolean(after?.llmPreparedAt);
}

async function processOne(host: Host, paperId: string, force: boolean): Promise<"ok" | "fail" | "cancelled" | "skip"> {
  const paper = await repo.getPaper(paperId);
  if (!paper?.pdfPath) return "skip";
  if (cancelled.has(paperId)) {
    cancelled.delete(paperId);
    return "cancelled";
  }
  if (paper.mineruStatus === "done" && paper.parsedMarkdown.trim()) {
    await autoPrepare(host, paperId);
    return "ok";
  }
  const settings = host.mineru();
  if (!settings.configured) return "skip";

  await retireActive(paperId);
  const job = await repo.createJob(paperId, "mineruParse", paper.pdfPath);
  await repo.updateJob(job.id, { status: "running", startedAt: nowIso() });
  try {
    let docRef = paper.mineruDocRef;
    let parseIds = paper.mineruParseIds;
    let provider = paper.mineruProvider as MineruProviderKind | null;
    // 恢复仅同源：pending 论文必须带有提交时记录的 provider 才能续轮询；
    // 旧数据（status=submitted 但无 provider）只能重新提交，由后端按 order 重选源。
    const canResume =
      !force &&
      (paper.mineruStatus === "submitted" || paper.mineruStatus === "parsing") &&
      Boolean(docRef) &&
      Boolean(provider);
    if (!canResume) {
      await repo.setMineruState(paperId, { status: "queued", error: null });
      await host.refresh();
      if (cancelled.has(paperId)) throw new Error("CANCELLED");
      const submitted = await mineruSubmit(paperId, paper.pdfPath, force);
      if (cancelled.has(paperId)) throw new Error("CANCELLED");
      docRef = submitted.shortId;
      parseIds = submitted.parseIds;
      provider = submitted.provider;
      await repo.setMineruState(paperId, {
        status: "submitted",
        parseId: parseIds[0] ?? null,
        parseIds,
        docRef,
        provider,
        error: null,
      });
      await host.refresh();
      if (submitted.status === "done") {
        const markdown = await mineruMarkdown(
          provider,
          docRef,
          submitted.tier || settings.tier,
          settings.pageRange,
        );
        await repo.saveParsedMarkdown(paperId, markdown);
        await repo.setMineruState(paperId, { status: "done", error: null });
        await repo.updateJob(job.id, { status: "done", finishedAt: nowIso() });
        await host.refresh();
        await autoPrepare(host, paperId);
        return "ok";
      }
    }
    if (!docRef || !provider) throw new Error("MinerU 没有返回文档编号");
    const markdown = await pollMarkdown(
      host,
      paperId,
      provider,
      docRef,
      parseIds,
      settings.tier,
      settings.pageRange,
    );
    await repo.saveParsedMarkdown(paperId, markdown);
    await repo.setMineruState(paperId, { status: "done", error: null });
    await repo.updateJob(job.id, { status: "done", finishedAt: nowIso() });
    await host.refresh();
    await autoPrepare(host, paperId);
    return "ok";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cancelled.has(paperId) || message === "CANCELLED") {
      cancelled.delete(paperId);
      await repo.updateJob(job.id, { status: "cancelled", error: "cancelled", finishedAt: nowIso() });
      await repo.setMineruState(paperId, { status: "cancelled" });
      await host.refresh();
      return "cancelled";
    }
    await repo.updateJob(job.id, { status: "error", error: message, finishedAt: nowIso() });
    await repo.setMineruState(paperId, { status: "error", error: message });
    await host.refresh();
    return "fail";
  }
}

/** 连续失败达到该值即熔断剩余批次：解析源大概率繁忙或不可用，继续只会逐篇耗时超时。 */
const CONSECUTIVE_FAIL_LIMIT = 3;

export async function runMineruBatch(host: Host, paperIds: string[], force = false): Promise<void> {
  // 守卫语义：order 中无任何启用源 → 静默返回（入口 importPdfs/retryMineru 已给出指引）。
  if (!host.mineru().configured) return;
  let ok = 0;
  let fail = 0;
  let consecutiveFails = 0;
  let pausedCount = 0;
  for (const paperId of paperIds) {
    if (consecutiveFails >= CONSECUTIVE_FAIL_LIMIT) {
      pausedCount = paperIds.length - ok - fail;
      break;
    }
    const result = await processOne(host, paperId, force);
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
    host.flash(
      "error",
      `MinerU 解析连续失败 ${consecutiveFails} 篇，已暂停剩余 ${pausedCount} 篇。解析源可能繁忙或不可用，可在设置页测试连接，稍后在 INTAKE 页重试。`,
    );
    return;
  }
  if (fail) {
    host.flash("error", `MinerU 解析失败 ${fail} 篇，可在资料栏重试。`);
  } else if (ok && !host.hasKey()) {
    host.flash("warn", "解析完成。尚未配置 AI，书目仍使用文件名，可稍后补全。");
  } else if (ok) {
    host.flash("ok", `MinerU 解析完成 ${ok} 篇。阅读状态未改动。`);
  }
}

export async function resumeMineru(host: Host): Promise<void> {
  if (!host.mineru().configured) return;
  const pending = await repo.listPendingMineru();
  if (pending.length) await runMineruBatch(host, pending, false);
  if (host.hasKey()) await backfillMeta(host);
}

export async function backfillMeta(host: Host): Promise<void> {
  if (!host.hasKey()) return;
  const ids = await repo.listReadyForMeta();
  let filled = 0;
  for (const id of ids) {
    if (await autoPrepare(host, id)) filled += 1;
  }
  if (filled) host.flash("ok", `已为 ${filled} 篇论文补全信息。阅读状态未改动。`);
}
