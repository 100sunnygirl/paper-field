import {
  mineruMarkdown,
  mineruParseStatuses,
  mineruSubmit,
  type MineruSettings,
} from "./mineru";
import { repo } from "./repo";
import { nowIso } from "./util";

interface Host {
  mineru: () => MineruSettings;
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
  docRef: string,
  parseIds: number[],
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
    if (!parseIds.length) {
      return mineruMarkdown(host.mineru(), docRef, tier, pageRange);
    }
    const polls = await pollStatuses(host.mineru(), parseIds);
    const waiting = polls.some((item) => item.status === "pending" || item.status === "parsing");
    const failed = polls.find((item) => item.status === "failed");
    const settled = polls.some((item) => item.status === "done" || item.status === "superseded");
    if (!waiting && failed && !settled) {
      throw new Error(failed.error || "MinerU 解析失败");
    }
    if (!waiting) {
      return mineruMarkdown(host.mineru(), docRef, tier, pageRange);
    }
    await sleep(4000);
  }
  throw new Error("MinerU 解析超时");
}

async function pollStatuses(settings: MineruSettings, parseIds: number[]) {
  let last: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await mineruParseStatuses(settings, parseIds);
    } catch (err) {
      last = err;
      await sleep(2000);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function autoPrepare(host: Host, paperId: string): Promise<boolean> {
  if (!host.hasKey()) return false;
  const paper = await repo.getPaper(paperId);
  if (!paper || paper.llmPreparedAt || !paper.parsedMarkdown.trim()) return false;
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
    const canResume =
      !force &&
      (paper.mineruStatus === "submitted" || paper.mineruStatus === "parsing") &&
      Boolean(docRef);
    if (!canResume) {
      await repo.setMineruState(paperId, { status: "queued", error: null });
      await host.refresh();
      if (cancelled.has(paperId)) throw new Error("CANCELLED");
      const submitted = await mineruSubmit(settings, paper.pdfPath, paperId, force);
      if (cancelled.has(paperId)) throw new Error("CANCELLED");
      docRef = submitted.shortId;
      parseIds = submitted.parseIds;
      await repo.setMineruState(paperId, {
        status: "submitted",
        parseId: parseIds[0] ?? null,
        parseIds,
        docRef,
        error: null,
      });
      await host.refresh();
      if (submitted.status === "done") {
        const markdown = await mineruMarkdown(settings, docRef, submitted.tier || settings.tier, settings.pageRange);
        await repo.saveParsedMarkdown(paperId, markdown);
        await repo.setMineruState(paperId, { status: "done", error: null });
        await repo.updateJob(job.id, { status: "done", finishedAt: nowIso() });
        await host.refresh();
        await autoPrepare(host, paperId);
        return "ok";
      }
    }
    if (!docRef) throw new Error("MinerU 没有返回文档编号");
    const markdown = await pollMarkdown(host, paperId, docRef, parseIds, settings.tier, settings.pageRange);
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

export async function runMineruBatch(host: Host, paperIds: string[], force = false): Promise<void> {
  if (!host.mineru().configured) return;
  let ok = 0;
  let fail = 0;
  for (const paperId of paperIds) {
    const result = await processOne(host, paperId, force);
    if (result === "ok") ok += 1;
    if (result === "fail") fail += 1;
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
