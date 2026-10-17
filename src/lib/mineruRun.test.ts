import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestEngine, type TestEngineHandle } from "../test/helpers";
import type { SqlEngine } from "./engine";
import type { MineruParsePoll, MineruSettingsV2, MineruSubmitResult } from "./mineru";

/**
 * 解析流程跑在真实 repo 上：sql.js 内存库 + 生产 applySchema，作业与所有权都走真实 SQL。
 * 只替换 MinerU 的 IPC（./mineru）。保持默认 jsdom 环境：轮询间隔用的是 window.setTimeout。
 */
const holder = vi.hoisted(() => ({ engine: null as SqlEngine | null }));

vi.mock("./engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine")>();
  return { ...actual, getEngine: () => Promise.resolve(holder.engine!) };
});

vi.mock("./mineru", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mineru")>();
  return {
    ...actual,
    mineruSubmit: vi.fn(),
    mineruParseStatuses: vi.fn(),
    mineruMarkdown: vi.fn(),
    mineruCurrentFingerprint: vi.fn(),
  };
});

import { mineruCurrentFingerprint, mineruMarkdown, mineruParseStatuses, mineruSubmit } from "./mineru";
import {
  dequeueFromBatch,
  enqueueBackfill,
  enqueueMeta,
  enqueueMineru,
  enqueueMineruBatch,
  forgetPapers,
  PAUSED_ERROR,
  resumeMineru,
  runMineruBatch,
  setMineruTiming,
  STALE_CRED_ERROR,
  stopBatch,
} from "./mineruRun";
import { cancelJob, liveJobsFor, resetLiveJobs } from "./jobs";
import { getActivity, queueBatch, resetActivity, subscribeActivity } from "./activity";
import { repo } from "./repo";

const FP = "pf-cred-v1:match";

const settings: MineruSettingsV2 = {
  version: 2,
  order: ["local", "ssh", "api"],
  local: { enabled: true, socketPath: "~/.mineru/doclib.sock" },
  ssh: {
    enabled: true,
    host: "imac",
    port: 22,
    user: "yang",
    identityFile: "",
    socketPath: "~/.mineru/doclib.sock",
    inboxDir: "~/.mineru/paper-field-inbox",
  },
  api: { hasToken: false, modelVersion: "pipeline", language: "ch", enableFormula: true, enableTable: true },
  tier: "standard",
  pageRange: "all",
  configured: true,
};

let handle: TestEngineHandle;
let domainId: string;
let pdfSeq = 0;

/** 测试里挂起的 IPC：用例结束时统一放行（以失败收场），不让后台链卡住下一个用例。 */
const openHangs: Array<() => void> = [];

function hang<T>() {
  let release!: (value: T) => void;
  let fail!: (err: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  promise.catch(() => undefined);
  openHangs.push(() => fail(new Error("用例结束时仍未放行")));
  return { promise, release };
}

/** 等两条后台链（解析 → AI 补全）都跑空：解析成功后入链的补全也一并跑完。 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => enqueueMineru(async () => resolve()));
  await new Promise<void>((resolve) => enqueueMeta(async () => resolve()));
}

beforeEach(async () => {
  handle = await makeTestEngine();
  holder.engine = handle.engine;
  resetActivity();
  resetLiveJobs();
  setMineruTiming({ pollMs: 1, retryMs: 1 });
  vi.mocked(mineruSubmit).mockReset();
  vi.mocked(mineruParseStatuses).mockReset();
  vi.mocked(mineruMarkdown).mockReset();
  vi.mocked(mineruCurrentFingerprint).mockReset().mockResolvedValue(FP);
  domainId = (await repo.createDomain({ name: "多模态", code: "MM-01" })).id;
});

afterEach(async () => {
  // 用例失败时可能留下挂起的 IPC 或无限轮询：放行并取消，后台链跑空后再关库。
  openHangs.splice(0).forEach((fail) => fail());
  for (const jobId of Object.keys(getActivity().jobs)) await cancelJob(jobId);
  await settle();
  handle.close();
});

type MineruPatch = Parameters<typeof repo.setMineruState>[1];

/** 建一篇带 PDF 的论文（初始 pending），可选地摆好解析状态与已有全文。 */
async function makePaper(state?: MineruPatch, markdown?: string): Promise<string> {
  pdfSeq += 1;
  const paper = await repo.createPaper({ domainId, pdfPath: `/papers/p${pdfSeq}.pdf` });
  if (state) await repo.setMineruState(paper.id, state);
  if (markdown !== undefined) await repo.saveParsedMarkdown(paper.id, markdown);
  return paper.id;
}

/** 已提交、可同源续跑的在途状态。 */
function inflight(
  provider: string,
  docRef: string,
  parseIds: string[],
  status: "submitted" | "parsing" = "submitted",
  credFingerprint: string | null = FP,
): MineruPatch {
  return { status, docRef, parseIds, parseId: parseIds[0] ?? null, provider, credFingerprint };
}

async function paperOf(id: string) {
  const paper = await repo.getPaper(id);
  if (!paper) throw new Error(`论文不存在：${id}`);
  return paper;
}

async function jobsOf(paperId: string) {
  return (await repo.listJobs(200)).filter((job) => job.paperId === paperId);
}

/** 模拟 runPrepareMeta 的落库效果：llm_prepared_at 写入。 */
async function markPrepared(paperId: string): Promise<void> {
  await holder.engine!.execute("UPDATE papers SET llm_prepared_at = ? WHERE id = ?", [new Date().toISOString(), paperId]);
}

function makeHost(
  options: {
    hasKey?: boolean;
    configured?: boolean;
    prepare?: (paperId: string, overwrite: boolean, quiet: boolean) => Promise<void>;
  } = {},
) {
  return {
    mineru: () => ({ ...settings, configured: options.configured ?? true }),
    hasKey: () => options.hasKey ?? true,
    refresh: vi.fn(async () => undefined),
    flash: vi.fn(),
    prepare: vi.fn(options.prepare ?? (async (paperId: string) => markPrepared(paperId))),
  };
}

function submitResult(overrides: Partial<MineruSubmitResult> = {}): MineruSubmitResult {
  return {
    provider: "local",
    remotePath: "/remote/a.pdf",
    shortId: "doc-1",
    parseIds: ["7"],
    status: "running",
    tier: "standard",
    credFingerprint: FP,
    ...overrides,
  };
}

function poll(status: string, overrides: Partial<MineruParsePoll> = {}): MineruParsePoll {
  return { id: "7", status, error: null, progress: null, ...overrides };
}

/** 按 docRef 返回全文，便于分辨是哪一轮取回的。 */
function markdownByDoc() {
  vi.mocked(mineruMarkdown).mockImplementation(async (_provider, docRef) => `# ${docRef}`);
}

describe("autoPrepare（防覆盖语义）", () => {
  it("解析完成后调用 host.prepare(paperId, false, true)：overwrite=false 使 applyPreparedMeta 用户编辑锁生效", async () => {
    const id = await makePaper({ status: "done" }, "# 已解析全文");
    const host = makeHost();

    await runMineruBatch(host, [id], false);
    await settle();

    expect(host.prepare).toHaveBeenCalledTimes(1);
    expect(host.prepare).toHaveBeenCalledWith(id, false, true);
    expect((await paperOf(id)).llmPreparedAt).not.toBeNull();
    // 已解析的论文不再提交 MinerU，也不建解析作业。
    expect(mineruSubmit).not.toHaveBeenCalled();
    expect(await jobsOf(id)).toEqual([]);
    // quiet=true：不闪「AI 作业完成」提示，只保留解析完成提示。
    expect(host.flash).toHaveBeenCalledWith("ok", "MinerU 解析完成 1 篇。阅读状态未改动。");
  });

  it("llmPreparedAt 已设的论文不再重复补全", async () => {
    const id = await makePaper({ status: "done" }, "# md");
    await markPrepared(id);
    const host = makeHost();

    await runMineruBatch(host, [id], false);
    await settle();

    expect(host.prepare).not.toHaveBeenCalled();
  });

  it("没有解析文本时不调用 prepare", async () => {
    const id = await makePaper();
    const host = makeHost();
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ status: "done" }));
    vi.mocked(mineruMarkdown).mockResolvedValue("  \n ");

    await runMineruBatch(host, [id], false);
    await settle();

    expect((await paperOf(id)).mineruStatus).toBe("done");
    expect(host.prepare).not.toHaveBeenCalled();
  });

  it("未配置 LLM key 时提示补全缺失而不是静默成功", async () => {
    const id = await makePaper({ status: "done" }, "# md");
    const host = makeHost({ hasKey: false });

    await runMineruBatch(host, [id], false);
    await settle();

    expect(host.prepare).not.toHaveBeenCalled();
    expect(host.flash).toHaveBeenCalledWith("warn", "解析完成。尚未配置 AI，书目仍使用文件名，可稍后补全。");
  });

  it("自动补全排在 AI 队列上：补全还没结束，后面的解析照常进行", async () => {
    const a = await makePaper();
    const b = await makePaper();
    const slow = hang<void>();
    const host = makeHost({
      prepare: async (paperId) => {
        await slow.promise;
        await markPrepared(paperId);
      },
    });
    vi.mocked(mineruSubmit).mockImplementation(async (paperId) => submitResult({ status: "done", shortId: `doc-${paperId}` }));
    markdownByDoc();

    await runMineruBatch(host, [a, b], false);

    // 两篇都已解析完成，第一篇的补全还挂在 AI 队列上。
    expect((await paperOf(a)).mineruStatus).toBe("done");
    expect((await paperOf(b)).mineruStatus).toBe("done");
    await vi.waitFor(() => expect(host.prepare).toHaveBeenCalledTimes(1));
    expect(host.prepare).toHaveBeenCalledWith(a, false, true);

    slow.release();
    await settle();
    expect(host.prepare).toHaveBeenCalledTimes(2);
    expect(host.prepare).toHaveBeenLastCalledWith(b, false, true);
    expect((await paperOf(b)).llmPreparedAt).not.toBeNull();
  });
});

describe("提交与轮询", () => {
  it("官方 API（parseIds=[]）必须先轮询 mineru_parse_statuses 等到 done 再取 markdown（I4b）", async () => {
    const id = await makePaper();
    const host = makeHost({ hasKey: false });
    vi.mocked(mineruSubmit).mockResolvedValue(
      submitResult({ provider: "api", remotePath: "", parseIds: [], shortId: "batch-1", tier: "pipeline", status: "running" }),
    );
    const statuses = vi.mocked(mineruParseStatuses).mockResolvedValue([poll("done", { id, progress: "10/10" })]);
    vi.mocked(mineruMarkdown).mockResolvedValue("# api markdown");

    await runMineruBatch(host, [id], false);

    // 直接取 markdown 的短路分支（!parseIds.length && provider!=='api'）不得触发。
    expect(statuses).toHaveBeenCalledWith("api", "batch-1", [], id, FP);
    // 轮询路径的 tier 取当前设置（同步 done 路径才用 SubmitResult.tier）。
    expect(mineruMarkdown).toHaveBeenCalledWith("api", "batch-1", "standard", "all", id, FP);
    expect(statuses.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(mineruMarkdown).mock.invocationCallOrder[0]);

    const paper = await paperOf(id);
    // 提交成功即记录实际来源与指纹，重启后仍可同源轮询。
    expect(paper).toMatchObject({
      mineruStatus: "done",
      mineruError: null,
      mineruProvider: "api",
      mineruDocRef: "batch-1",
      mineruCredFingerprint: FP,
      parsedMarkdown: "# api markdown",
    });
    const [job] = await jobsOf(id);
    expect(job).toMatchObject({ type: "mineruParse", status: "done", prompt: paper.pdfPath });
    expect(paper.mineruJobId).toBe(job.id);
  });

  it("doclib 同步完成（status=done）直接取 markdown，不进入轮询", async () => {
    const id = await makePaper();
    const host = makeHost({ hasKey: false });
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ status: "done", tier: "flash" }));
    vi.mocked(mineruMarkdown).mockResolvedValue("# fast markdown");

    await runMineruBatch(host, [id], false);

    expect(mineruParseStatuses).not.toHaveBeenCalled();
    // 同步完成用提交结果里的 tier。
    expect(mineruMarkdown).toHaveBeenCalledWith("local", "doc-1", "flash", "all", id, FP);
    expect(await paperOf(id)).toMatchObject({ mineruStatus: "done", parsedMarkdown: "# fast markdown" });
  });

  it("本地/SSH 源无 parseIds 时允许直接取 markdown（doclib 短路）", async () => {
    const id = await makePaper();
    const host = makeHost({ hasKey: false });
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ parseIds: [] }));
    vi.mocked(mineruMarkdown).mockResolvedValue("# direct");

    await runMineruBatch(host, [id], false);

    expect(mineruParseStatuses).not.toHaveBeenCalled();
    expect(mineruMarkdown).toHaveBeenCalledWith("local", "doc-1", "standard", "all", id, FP);
    expect(await paperOf(id)).toMatchObject({ mineruStatus: "done", parsedMarkdown: "# direct" });
  });

  it("等待中的解析会先轮询再在 done 后取回（含 pending→done 一次推进）", async () => {
    const id = await makePaper();
    const host = makeHost({ hasKey: false });
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ status: "running" }));
    const statuses = vi
      .mocked(mineruParseStatuses)
      .mockResolvedValueOnce([poll("pending")])
      .mockResolvedValueOnce([poll("done")]);
    vi.mocked(mineruMarkdown).mockResolvedValue("# after-wait");

    await runMineruBatch(host, [id], false);

    expect(statuses).toHaveBeenCalledTimes(2);
    expect(mineruMarkdown).toHaveBeenCalledTimes(1);
    expect(mineruMarkdown).toHaveBeenCalledWith("local", "doc-1", "standard", "all", id, FP);
    expect(await paperOf(id)).toMatchObject({ mineruStatus: "done", parsedMarkdown: "# after-wait" });
  });

  it("轮询报 failed 时作业与论文状态置 error", async () => {
    const id = await makePaper();
    const host = makeHost();
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ status: "running" }));
    vi.mocked(mineruParseStatuses).mockResolvedValue([poll("failed", { error: "页数超限" })]);

    await runMineruBatch(host, [id], false);

    expect(host.flash).toHaveBeenCalledWith("error", "MinerU 解析失败 1 篇，可在资料栏重试。");
    expect(mineruMarkdown).not.toHaveBeenCalled();
    expect(await paperOf(id)).toMatchObject({ mineruStatus: "error", mineruError: "页数超限", parsedMarkdown: "" });
    const [job] = await jobsOf(id);
    expect(job).toMatchObject({ status: "error", error: "页数超限" });
  });
});

describe("恢复仅同源（I4d）", () => {
  it("submitted + 已记录 provider：不重新提交，用同源轮询", async () => {
    const id = await makePaper(inflight("ssh", "doc-resume", ["9"]));
    const host = makeHost({ hasKey: false });
    vi.mocked(mineruParseStatuses).mockResolvedValue([poll("done", { id: "9" })]);
    vi.mocked(mineruMarkdown).mockResolvedValue("# resumed");

    await runMineruBatch(host, [id], false);

    expect(mineruSubmit).not.toHaveBeenCalled();
    expect(mineruCurrentFingerprint).toHaveBeenCalledWith("ssh");
    expect(mineruParseStatuses).toHaveBeenCalledWith("ssh", "doc-resume", ["9"], id, FP);
    expect(mineruMarkdown).toHaveBeenCalledWith("ssh", "doc-resume", "standard", "all", id, FP);
    expect(await paperOf(id)).toMatchObject({
      mineruStatus: "done",
      mineruProvider: "ssh",
      mineruDocRef: "doc-resume",
      parsedMarkdown: "# resumed",
    });
    expect((await jobsOf(id)).map((job) => job.status)).toEqual(["done"]);
  });

  it("源级错误置 mineru_status=error，不自动换源重提", async () => {
    const id = await makePaper(inflight("ssh", "doc-resume", ["9"], "parsing"));
    const host = makeHost();
    vi.mocked(mineruParseStatuses).mockRejectedValue(new Error("SSH 连接中断"));

    await runMineruBatch(host, [id], false);

    expect(mineruSubmit).not.toHaveBeenCalled();
    // pollStatuses 同源重试三次后放弃。
    expect(mineruParseStatuses).toHaveBeenCalledTimes(3);
    const paper = await paperOf(id);
    expect(paper.mineruStatus).toBe("error");
    expect(paper.mineruError).toContain("解析源不可用");
    expect(paper.mineruError).toContain("SSH 连接中断");
    expect(paper.mineruError).toContain("可点击重新解析换源重提");
    expect(paper.mineruProvider).toBe("ssh");
    const [job] = await jobsOf(id);
    expect(job.status).toBe("error");
  });

  it("在途论文缺指纹时失败关闭，不自动重提", async () => {
    const id = await makePaper(inflight("ssh", "doc-old", ["9"], "submitted", null));
    await repo.setMineruState(id, { provider: null });
    const host = makeHost();

    await runMineruBatch(host, [id], false);

    expect(mineruSubmit).not.toHaveBeenCalled();
    expect(mineruParseStatuses).not.toHaveBeenCalled();
    expect(await paperOf(id)).toMatchObject({ mineruStatus: "error", mineruError: STALE_CRED_ERROR });
    expect(await jobsOf(id)).toEqual([]);
  });

  it("force=true 时即使可恢复也重新提交（retryMineru 跨源入口）", async () => {
    const id = await makePaper(inflight("ssh", "doc-old", ["9"], "parsing"));
    const host = makeHost({ hasKey: false });
    vi.mocked(mineruSubmit).mockResolvedValue(
      submitResult({ provider: "api", parseIds: [], shortId: "batch-2", status: "running", tier: "pipeline" }),
    );
    vi.mocked(mineruParseStatuses).mockResolvedValue([poll("done", { id })]);
    vi.mocked(mineruMarkdown).mockResolvedValue("# forced");

    await runMineruBatch(host, [id], true);

    expect(mineruSubmit).toHaveBeenCalledTimes(1);
    expect(mineruSubmit).toHaveBeenCalledWith(id, expect.stringContaining(".pdf"), true);
    expect(mineruParseStatuses).toHaveBeenCalledTimes(1);
    expect(mineruParseStatuses).toHaveBeenCalledWith("api", "batch-2", [], id, FP);
    expect(await paperOf(id)).toMatchObject({
      mineruStatus: "done",
      mineruProvider: "api",
      mineruDocRef: "batch-2",
      mineruParseIds: [],
      parsedMarkdown: "# forced",
    });
  });
});

describe("凭据指纹续跑（M6）", () => {
  it("缺指纹的在途论文失败关闭，不轮询也不重新提交", async () => {
    const id = await makePaper(inflight("api", "doc-old", ["9"], "parsing", null));
    const host = makeHost();

    await resumeMineru(host);

    expect(mineruParseStatuses).not.toHaveBeenCalled();
    expect(mineruMarkdown).not.toHaveBeenCalled();
    expect(mineruSubmit).not.toHaveBeenCalled();
    expect(await paperOf(id)).toMatchObject({ mineruStatus: "error", mineruError: STALE_CRED_ERROR });
    expect(host.flash).toHaveBeenCalledWith("error", STALE_CRED_ERROR);
  });

  it("指纹与当前凭据不一致时不轮询、不自动重提", async () => {
    const id = await makePaper(inflight("api", "doc-old", [], "submitted", "pf-cred-v1:old"));
    vi.mocked(mineruCurrentFingerprint).mockResolvedValue("pf-cred-v1:new");
    const host = makeHost();

    await resumeMineru(host);

    expect(mineruCurrentFingerprint).toHaveBeenCalledWith("api");
    expect(mineruParseStatuses).not.toHaveBeenCalled();
    expect(mineruSubmit).not.toHaveBeenCalled();
    expect(await paperOf(id)).toMatchObject({ mineruStatus: "error", mineruError: STALE_CRED_ERROR });
    expect(await jobsOf(id)).toEqual([]);
  });

  it("指纹匹配时把列值传给续跑轮询", async () => {
    const id = await makePaper(inflight("ssh", "doc-resume", ["9"]));
    vi.mocked(mineruParseStatuses).mockResolvedValue([poll("done", { id: "9" })]);
    vi.mocked(mineruMarkdown).mockResolvedValue("# resumed");
    const host = makeHost();

    await resumeMineru(host);

    expect(mineruSubmit).not.toHaveBeenCalled();
    expect(mineruParseStatuses).toHaveBeenCalledWith("ssh", "doc-resume", ["9"], id, FP);
    expect(host.flash).not.toHaveBeenCalledWith("error", STALE_CRED_ERROR);
    expect(await paperOf(id)).toMatchObject({ mineruStatus: "done", parsedMarkdown: "# resumed" });
  });

  it("指纹匹配并继续轮询时提示继续上次未完成的解析", async () => {
    await makePaper(inflight("ssh", "doc-resume", ["9"], "parsing"));
    vi.mocked(mineruParseStatuses).mockResolvedValue([poll("done", { id: "9" })]);
    vi.mocked(mineruMarkdown).mockResolvedValue("# resumed");
    const host = makeHost();

    await resumeMineru(host);

    expect(host.flash).toHaveBeenCalledWith("ok", "继续上次未完成的解析。");
    expect(host.flash.mock.calls.map(([, text]) => text)).not.toContain("应用上次退出，作业中断");
  });

  it("续跑覆盖 queued / submitted / parsing 三种状态，其余状态不动", async () => {
    const queued = await makePaper();
    await repo.resetMineru([queued]);
    const submitted = await makePaper(inflight("ssh", "doc-s", ["1"]));
    const parsing = await makePaper(inflight("api", "doc-p", [], "parsing"));
    const pending = await makePaper();
    const cancelled = await makePaper({ status: "cancelled" });
    const failed = await makePaper({ status: "error", error: "旧错误" });
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ status: "done", shortId: "doc-q" }));
    vi.mocked(mineruParseStatuses).mockResolvedValue([poll("done")]);
    markdownByDoc();
    const host = makeHost();

    await resumeMineru(host);
    await settle();

    // queued 没有提交记录，只能重新提交（不带 force）；在途的两篇同源续轮询。
    expect(mineruSubmit).toHaveBeenCalledTimes(1);
    expect(mineruSubmit).toHaveBeenCalledWith(queued, expect.any(String), false);
    expect(mineruParseStatuses).toHaveBeenCalledWith("ssh", "doc-s", ["1"], submitted, FP);
    expect(mineruParseStatuses).toHaveBeenCalledWith("api", "doc-p", [], parsing, FP);
    expect(await paperOf(queued)).toMatchObject({ mineruStatus: "done", parsedMarkdown: "# doc-q" });
    expect(await paperOf(submitted)).toMatchObject({ mineruStatus: "done", parsedMarkdown: "# doc-s" });
    expect(await paperOf(parsing)).toMatchObject({ mineruStatus: "done", parsedMarkdown: "# doc-p" });
    expect((await paperOf(pending)).mineruStatus).toBe("pending");
    expect((await paperOf(cancelled)).mineruStatus).toBe("cancelled");
    expect(await paperOf(failed)).toMatchObject({ mineruStatus: "error", mineruError: "旧错误" });
    expect(host.flash).toHaveBeenCalledWith("ok", "继续上次未完成的解析。");
    // 每篇只补全一次：解析成功后的自动补全在前，回填找不到漏网的论文。
    expect(host.prepare).toHaveBeenCalledTimes(3);
  });
});

describe("取消：作业取消与所有权", () => {
  it("轮询返回前取消：不写全文、不标 done、不自动补全，批次计取消", async () => {
    const id = await makePaper(inflight("local", "doc-1", [], "parsing"), "# 已有全文");
    const host = makeHost();
    const hung = hang<string>();
    vi.mocked(mineruMarkdown).mockReturnValue(hung.promise);

    const run = runMineruBatch(host, [id], false);
    await vi.waitFor(() => expect(mineruMarkdown).toHaveBeenCalled());
    const [jobId] = liveJobsFor(id, "mineruParse");
    await cancelJob(jobId);
    hung.release("# late");
    await run;
    await settle();

    expect(mineruSubmit).not.toHaveBeenCalled();
    expect(await paperOf(id)).toMatchObject({ mineruStatus: "cancelled", parsedMarkdown: "# 已有全文" });
    expect(await repo.jobStatus(jobId)).toBe("cancelled");
    expect(host.prepare).not.toHaveBeenCalled();
    expect(host.flash).not.toHaveBeenCalled();
    expect(getActivity().tally).toMatchObject({ done: 0, cancelled: 1 });
    expect(getActivity().batches[0]?.results[id]).toBe("cancelled");
  });

  it("提交已完成但全文返回前取消：同样不落盘", async () => {
    const id = await makePaper(undefined, "# 已有全文");
    const host = makeHost();
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ status: "done" }));
    const hung = hang<string>();
    vi.mocked(mineruMarkdown).mockReturnValue(hung.promise);

    const run = runMineruBatch(host, [id], false);
    await vi.waitFor(() => expect(mineruMarkdown).toHaveBeenCalled());
    const [jobId] = liveJobsFor(id, "mineruParse");
    await cancelJob(jobId);
    hung.release("# late");
    await run;
    await settle();

    expect(await paperOf(id)).toMatchObject({ mineruStatus: "cancelled", parsedMarkdown: "# 已有全文" });
    expect(await repo.jobStatus(jobId)).toBe("cancelled");
    expect(host.prepare).not.toHaveBeenCalled();
    expect(getActivity().tally.done).toBe(0);
    expect(getActivity().batches[0]?.results[id]).toBe("cancelled");
  });

  it("取消后立刻重新解析：旧一轮放行后不写任何状态，新一轮正常完成", async () => {
    const id = await makePaper();
    const host = makeHost({ hasKey: false });
    const oldPoll = hang<MineruParsePoll[]>();
    const newSubmit = hang<MineruSubmitResult>();
    vi.mocked(mineruSubmit)
      .mockResolvedValueOnce(submitResult({ provider: "ssh", shortId: "doc-old", credFingerprint: "pf-cred-v1:old" }))
      .mockReturnValueOnce(newSubmit.promise);
    vi.mocked(mineruParseStatuses).mockImplementation(async (_provider, docRef) =>
      docRef === "doc-old" ? oldPoll.promise : [poll("done")],
    );
    markdownByDoc();

    enqueueMineruBatch(host, [id], false);
    await vi.waitFor(() => expect(mineruParseStatuses).toHaveBeenCalledTimes(1));
    const [oldJob] = liveJobsFor(id, "mineruParse");
    // 与 store.retryMineru 同序：取消旧作业 → 重置并收回所有权 → 强制入链。
    await cancelJob(oldJob);
    await repo.resetMineru([id]);
    enqueueMineruBatch(host, [id], true);

    oldPoll.release([poll("done")]);
    await vi.waitFor(() => expect(mineruSubmit).toHaveBeenCalledTimes(2));
    // 新一轮已认领、还在提交：旧一轮已经结束，没有把 cancelled / 旧来源 / 旧指纹写回去。
    const mid = await paperOf(id);
    expect(mid).toMatchObject({
      mineruStatus: "queued",
      mineruError: null,
      mineruProvider: null,
      mineruDocRef: null,
      mineruParseIds: [],
      mineruCredFingerprint: null,
      parsedMarkdown: "",
    });
    expect(mid.mineruJobId).not.toBe(oldJob);
    expect(liveJobsFor(id, "mineruParse")).toEqual([mid.mineruJobId]);
    expect(await repo.jobStatus(oldJob)).toBe("cancelled");

    newSubmit.release(submitResult({ provider: "api", shortId: "doc-new", parseIds: [] }));
    await settle();

    const done = await paperOf(id);
    expect(done).toMatchObject({
      mineruStatus: "done",
      mineruProvider: "api",
      mineruDocRef: "doc-new",
      mineruCredFingerprint: FP,
      parsedMarkdown: "# doc-new",
      mineruJobId: mid.mineruJobId,
    });
    expect(await repo.jobStatus(mid.mineruJobId!)).toBe("done");
    expect(await repo.jobStatus(oldJob)).toBe("cancelled");
    expect(getActivity().batches.map((batch) => batch.results[id])).toEqual(["cancelled", "ok"]);
  });

  it("新一轮已完成后旧一轮才返回：仍不覆盖新结果", async () => {
    const id = await makePaper();
    const host = makeHost({ hasKey: false });
    const oldPoll = hang<MineruParsePoll[]>();
    vi.mocked(mineruSubmit)
      .mockResolvedValueOnce(submitResult({ provider: "ssh", shortId: "doc-old", credFingerprint: "pf-cred-v1:old" }))
      .mockResolvedValueOnce(submitResult({ provider: "api", shortId: "doc-new", parseIds: [] }));
    vi.mocked(mineruParseStatuses).mockImplementation(async (_provider, docRef) =>
      docRef === "doc-old" ? oldPoll.promise : [poll("done")],
    );
    markdownByDoc();

    // 旧一轮不在解析链上（如启动续跑直接调用），新一轮入链后与它并发。
    const oldRun = runMineruBatch(host, [id], false);
    await vi.waitFor(() => expect(mineruParseStatuses).toHaveBeenCalledTimes(1));
    const [oldJob] = liveJobsFor(id, "mineruParse");
    await cancelJob(oldJob);
    await repo.resetMineru([id]);
    enqueueMineruBatch(host, [id], true);
    await settle();

    const fresh = await paperOf(id);
    expect(fresh).toMatchObject({ mineruStatus: "done", mineruDocRef: "doc-new", parsedMarkdown: "# doc-new" });

    oldPoll.release([poll("done")]);
    await oldRun;

    expect(await paperOf(id)).toEqual(fresh);
    expect(await repo.jobStatus(oldJob)).toBe("cancelled");
    expect(await repo.jobStatus(fresh.mineruJobId!)).toBe("done");
  });

  it("全文返回前所有权被收回（重新解析重置）：不写全文，状态保持重置后的 queued", async () => {
    const id = await makePaper();
    const host = makeHost();
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ status: "done" }));
    vi.mocked(mineruMarkdown).mockImplementation(async () => {
      await repo.resetMineru([id]);
      return "# late";
    });

    await runMineruBatch(host, [id], false);
    await settle();

    expect(await paperOf(id)).toMatchObject({
      mineruStatus: "queued",
      mineruDocRef: null,
      mineruProvider: null,
      mineruJobId: null,
      parsedMarkdown: "",
    });
    const [job] = await jobsOf(id);
    expect(job.status).toBe("cancelled");
    expect(host.prepare).not.toHaveBeenCalled();
    expect(getActivity().batches[0]?.results[id]).toBe("cancelled");
  });

  it("落库那一刻所有权被收回：全文、done 与作业完成整批回滚，作业以取消收场", async () => {
    const id = await makePaper();
    const host = makeHost();
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ status: "done" }));
    vi.mocked(mineruMarkdown).mockResolvedValue("# md");
    // 在提交成功的那个事务开始前插入一次重置：检查点已经过去，只剩事务本身的前提把关。
    const real = holder.engine!;
    let revoked = false;
    holder.engine = {
      execute: (sql, params) => real.execute(sql, params),
      select: (sql, params) => real.select(sql, params),
      batch: async (steps) => {
        if (!revoked && steps.some((step) => step.sql.includes("INSERT INTO paper_parse"))) {
          revoked = true;
          await repo.resetMineru([id]);
        }
        return real.batch(steps);
      },
    };

    await runMineruBatch(host, [id], false);
    await settle();

    expect(revoked).toBe(true);
    expect(await paperOf(id)).toMatchObject({ mineruStatus: "queued", mineruJobId: null, parsedMarkdown: "" });
    const [job] = await jobsOf(id);
    // 作业不能挂在 running：否则状态栏一直显示「作业运行中」。
    expect(job.status).toBe("cancelled");
    expect(await repo.activeJobIds([id])).toEqual([]);
    expect(host.prepare).not.toHaveBeenCalled();
    expect(getActivity().tally).toMatchObject({ done: 0, cancelled: 1 });
  });

  it("解析中删除论文：轮询立即结束，下一批照常进行", async () => {
    const p = await makePaper();
    const q = await makePaper();
    const host = makeHost({ hasKey: false });
    vi.mocked(mineruSubmit).mockImplementation(async (paperId) => submitResult({ shortId: `doc-${paperId}` }));
    vi.mocked(mineruParseStatuses).mockImplementation(async (_provider, _docRef, _ids, paperId) =>
      paperId === p ? [poll("parsing", { progress: "1/9" })] : [poll("done")],
    );
    markdownByDoc();
    const pollsOf = (paperId: string) => vi.mocked(mineruParseStatuses).mock.calls.filter((call) => call[3] === paperId).length;

    enqueueMineruBatch(host, [p], false);
    enqueueMineruBatch(host, [p, q], false);
    await vi.waitFor(() => expect(pollsOf(p)).toBeGreaterThanOrEqual(2));
    // 与 store.deletePaper 同序：先取消在途作业并移出等待批次，再删库。
    await forgetPapers([p]);
    await repo.deletePaper(p);
    const pollsAtDelete = pollsOf(p);
    await settle();

    expect(pollsOf(p)).toBeLessThanOrEqual(pollsAtDelete + 1);
    expect(await repo.getPaper(p)).toBeNull();
    expect(await jobsOf(p)).toEqual([]);
    expect(liveJobsFor(p)).toEqual([]);
    const [first, second] = getActivity().batches;
    expect(first).toMatchObject({ state: "done", results: { [p]: "cancelled" } });
    expect(second).toMatchObject({ state: "done", results: { [p]: "cancelled", [q]: "ok" } });
    expect(mineruSubmit).toHaveBeenCalledTimes(2);
    expect(await paperOf(q)).toMatchObject({ mineruStatus: "done", parsedMarkdown: `# doc-${q}` });
  });

  it("不经 forgetPapers 直接删库：失去所有权同样让轮询结束", async () => {
    const p = await makePaper();
    const q = await makePaper();
    const host = makeHost({ hasKey: false });
    vi.mocked(mineruSubmit).mockImplementation(async (paperId) => submitResult({ shortId: `doc-${paperId}` }));
    vi.mocked(mineruParseStatuses).mockImplementation(async (_provider, _docRef, _ids, paperId) =>
      paperId === p ? [poll("parsing")] : [poll("done")],
    );
    markdownByDoc();

    enqueueMineruBatch(host, [p, q], false);
    await vi.waitFor(() => expect(vi.mocked(mineruParseStatuses).mock.calls.length).toBeGreaterThanOrEqual(2));
    await repo.deletePaper(p);
    await settle();

    expect(liveJobsFor(p)).toEqual([]);
    expect(getActivity().batches[0]).toMatchObject({ state: "done", results: { [p]: "cancelled", [q]: "ok" } });
    expect((await paperOf(q)).mineruStatus).toBe("done");
  });

  it("建作业前论文被删除：本篇记为取消，同批其余论文照常解析", async () => {
    const p = await makePaper(inflight("ssh", "doc-p", ["9"]));
    const q = await makePaper();
    const host = makeHost({ hasKey: false });
    // 当前篇卡在续跑前的指纹核对上，此时还没有作业。
    const fingerprint = hang<string>();
    vi.mocked(mineruCurrentFingerprint).mockReturnValueOnce(fingerprint.promise);
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ status: "done", shortId: "doc-q" }));
    markdownByDoc();

    enqueueMineruBatch(host, [p, q], false);
    await vi.waitFor(() => expect(mineruCurrentFingerprint).toHaveBeenCalledTimes(1));
    await forgetPapers([p]);
    await repo.deletePaper(p);
    fingerprint.release(FP);
    await settle();

    expect(mineruParseStatuses).not.toHaveBeenCalled();
    expect(await jobsOf(p)).toEqual([]);
    expect(getActivity().batches[0]).toMatchObject({ state: "done", results: { [p]: "cancelled", [q]: "ok" } });
    expect(await paperOf(q)).toMatchObject({ mineruStatus: "done", parsedMarkdown: "# doc-q" });
  });
});

describe("移出队列与停止批次", () => {
  it("移出队列的论文轮到时直接跳过：记为取消，不提交 MinerU、不建作业", async () => {
    const id = await makePaper();
    const host = makeHost();
    const batchId = queueBatch("mineru", [id]);
    await dequeueFromBatch(batchId, id);

    await runMineruBatch(host, [id], false, batchId);

    expect(mineruSubmit).not.toHaveBeenCalled();
    expect(await jobsOf(id)).toEqual([]);
    expect((await paperOf(id)).mineruStatus).toBe("cancelled");
    expect(getActivity().batches[0].results).toEqual({ [id]: "cancelled" });
    expect(host.flash).not.toHaveBeenCalled();
  });

  it("移出按批次记：批次 1 移出的论文，在随后入链的批次 2 里照常解析", async () => {
    const a = await makePaper();
    const p = await makePaper();
    const host = makeHost({ hasKey: false });
    const aSubmit = hang<MineruSubmitResult>();
    vi.mocked(mineruSubmit).mockImplementation(async (paperId) =>
      paperId === a ? aSubmit.promise : submitResult({ status: "done", shortId: `doc-${paperId}` }),
    );
    markdownByDoc();

    enqueueMineruBatch(host, [a, p], false);
    await vi.waitFor(() => expect(mineruSubmit).toHaveBeenCalledTimes(1));
    const first = getActivity().batches[0].id;
    await dequeueFromBatch(first, p);
    expect((await paperOf(p)).mineruStatus).toBe("cancelled");
    enqueueMineruBatch(host, [p], false);
    aSubmit.release(submitResult({ status: "done", shortId: `doc-${a}` }));
    await settle();

    const [batch1, batch2] = getActivity().batches;
    expect(batch1.results).toEqual({ [a]: "ok", [p]: "cancelled" });
    expect(batch2.results).toEqual({ [p]: "ok" });
    expect(vi.mocked(mineruSubmit).mock.calls.filter(([paperId]) => paperId === p)).toHaveLength(1);
    expect(await paperOf(p)).toMatchObject({ mineruStatus: "done", parsedMarkdown: `# doc-${p}` });
  });

  it("停止批次落库：剩余论文记为已取消，之后续跑不再提交", async () => {
    const ids = [await makePaper(), await makePaper(), await makePaper()];
    await repo.resetMineru(ids); // 批量重试：都在 queued
    const host = makeHost();
    vi.mocked(mineruSubmit).mockImplementation(async (paperId) => submitResult({ shortId: `doc-${paperId}` }));
    vi.mocked(mineruParseStatuses).mockResolvedValue([poll("parsing")]);

    enqueueMineruBatch(host, ids, true);
    await vi.waitFor(() => expect(mineruParseStatuses).toHaveBeenCalled());
    const batchId = getActivity().batches[0].id;
    expect(await stopBatch(batchId)).toBe(3);
    await settle();

    for (const id of ids) expect((await paperOf(id)).mineruStatus).toBe("cancelled");
    expect((await jobsOf(ids[0])).map((job) => job.status)).toEqual(["cancelled"]);
    expect(await jobsOf(ids[1])).toEqual([]);
    expect(await jobsOf(ids[2])).toEqual([]);
    expect(getActivity().batches[0]).toMatchObject({
      state: "done",
      results: { [ids[0]]: "cancelled", [ids[1]]: "cancelled", [ids[2]]: "cancelled" },
    });

    // 重启或保存 MinerU 设置时的续跑：停掉的论文不会被重新提交。
    vi.mocked(mineruSubmit).mockClear();
    vi.mocked(mineruParseStatuses).mockClear();
    await resumeMineru(host);
    await settle();
    expect(mineruSubmit).not.toHaveBeenCalled();
    expect(mineruParseStatuses).not.toHaveBeenCalled();
    for (const id of ids) expect((await paperOf(id)).mineruStatus).toBe("cancelled");
  });

  it("停止时当前篇还卡在建作业前：不建作业，库里记为已取消，续跑不再捡起", async () => {
    const first = await makePaper(inflight("ssh", "doc-a", ["9"]));
    const second = await makePaper();
    const host = makeHost();
    // 当前篇卡在续跑前的指纹核对上，此时还没有作业可取消。
    const fingerprint = hang<string>();
    vi.mocked(mineruCurrentFingerprint).mockReturnValueOnce(fingerprint.promise);
    const batchId = queueBatch("mineru", [first, second]);

    const run = runMineruBatch(host, [first, second], false, batchId);
    await vi.waitFor(() => expect(mineruCurrentFingerprint).toHaveBeenCalledTimes(1));
    expect(liveJobsFor(first)).toEqual([]);
    expect(await stopBatch(batchId)).toBe(2);
    fingerprint.release(FP);
    await run;

    expect(mineruParseStatuses).not.toHaveBeenCalled();
    expect((await paperOf(first)).mineruStatus).toBe("cancelled");
    expect((await paperOf(second)).mineruStatus).toBe("cancelled");
    expect(await jobsOf(first)).toEqual([]);
    expect(getActivity().batches[0].results).toEqual({ [first]: "cancelled", [second]: "cancelled" });

    await resumeMineru(host);
    await settle();
    expect(mineruParseStatuses).not.toHaveBeenCalled();
    expect(mineruSubmit).not.toHaveBeenCalled();
  });

  it("停止落在建作业的那一刻：作业建好后自行取消，库里同样记为已取消", async () => {
    const ids = [await makePaper(), await makePaper()];
    await repo.resetMineru(ids);
    const host = makeHost();
    const batchId = queueBatch("mineru", ids);
    // 建作业的写入还在路上、作业尚未登记到本机时点了停止：只能打上移出标记，由作业自己收场。
    const real = holder.engine!;
    let stopped = 0;
    holder.engine = {
      execute: (sql, params) => real.execute(sql, params),
      select: (sql, params) => real.select(sql, params),
      batch: async (steps) => {
        if (!stopped && steps.some((step) => step.sql.includes("INSERT INTO llm_jobs"))) {
          stopped = await stopBatch(batchId);
        }
        return real.batch(steps);
      },
    };

    await runMineruBatch(host, ids, true, batchId);

    expect(stopped).toBe(2);
    expect(mineruSubmit).not.toHaveBeenCalled();
    for (const id of ids) expect((await paperOf(id)).mineruStatus).toBe("cancelled");
    expect((await jobsOf(ids[0])).map((job) => job.status)).toEqual(["cancelled"]);
    expect(await jobsOf(ids[1])).toEqual([]);

    await resumeMineru(host);
    await settle();
    expect(mineruParseStatuses).not.toHaveBeenCalled();
    expect(mineruSubmit).not.toHaveBeenCalled();
  });
});

describe("runMineruBatch 守卫", () => {
  it("order 中无启用源（configured=false）时静默返回，不创建作业", async () => {
    const id = await makePaper();
    const host = makeHost({ configured: false });

    await runMineruBatch(host, [id], false);

    expect(await jobsOf(id)).toEqual([]);
    expect(mineruSubmit).not.toHaveBeenCalled();
    expect(host.flash).not.toHaveBeenCalled();
    expect((await paperOf(id)).mineruStatus).toBe("pending");
  });

  it("没有 pdfPath 的论文跳过且不计失败", async () => {
    const paper = await repo.createPaper({ domainId, title: "只有书目" });
    const host = makeHost();

    await runMineruBatch(host, [paper.id], false);

    expect(await jobsOf(paper.id)).toEqual([]);
    expect(mineruSubmit).not.toHaveBeenCalled();
    expect(host.flash).not.toHaveBeenCalled();
    expect(getActivity().batches[0].results).toEqual({ [paper.id]: "skip" });
  });
});

describe("runMineruBatch · 连续失败熔断", () => {
  async function makePapers(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) ids.push(await makePaper());
    return ids;
  }

  it("连续 3 篇提交失败后暂停剩余批次并给出指引", async () => {
    const ids = await makePapers(5);
    const host = makeHost();
    // 模拟远端繁忙：提交一律超时失败
    vi.mocked(mineruSubmit).mockRejectedValue(new Error("SSH 远程：curl: (28) Operation timed out"));

    await runMineruBatch(host, ids, false);

    // 第 4、5 篇不再尝试
    expect(mineruSubmit).toHaveBeenCalledTimes(3);
    const [tone, text] = host.flash.mock.calls.at(-1)!;
    expect(tone).toBe("error");
    expect(text).toContain("连续失败 3 篇");
    expect(text).toContain("已暂停剩余 2 篇");
    expect(text).toContain("INTAKE");
    for (const id of ids.slice(0, 3)) {
      expect(await paperOf(id)).toMatchObject({ mineruStatus: "error", mineruError: "SSH 远程：curl: (28) Operation timed out" });
      expect((await jobsOf(id)).map((job) => job.status)).toEqual(["error"]);
    }
    for (const id of ids.slice(3)) {
      expect(await paperOf(id)).toMatchObject({ mineruStatus: "error", mineruError: PAUSED_ERROR, mineruJobId: null });
      expect(await jobsOf(id)).toEqual([]);
    }
  });

  it("失败被成功打断则不熔断，仍走普通失败汇总", async () => {
    const ids = await makePapers(3);
    const host = makeHost({ hasKey: false });
    vi.mocked(mineruSubmit)
      .mockRejectedValueOnce(new Error("busy"))
      // 第 2 篇提交即完成（status=done 直接取全文）
      .mockResolvedValueOnce(submitResult({ status: "done" }))
      .mockRejectedValueOnce(new Error("busy"));
    vi.mocked(mineruMarkdown).mockResolvedValue("# md");

    await runMineruBatch(host, ids, false);

    expect(mineruSubmit).toHaveBeenCalledTimes(3);
    const [tone, text] = host.flash.mock.calls.at(-1)!;
    expect(tone).toBe("error");
    expect(text).toContain("解析失败 2 篇");
    expect(text).not.toContain("已暂停");
    expect(await paperOf(ids[1])).toMatchObject({ mineruStatus: "done", parsedMarkdown: "# md" });
    expect((await paperOf(ids[2])).mineruStatus).toBe("error");
  });

  it("熔断暂停的篇数不含已移出队列的论文", async () => {
    const ids = await makePapers(5);
    const host = makeHost();
    vi.mocked(mineruSubmit).mockRejectedValue(new Error("busy"));
    const batchId = queueBatch("mineru", ids);
    await dequeueFromBatch(batchId, ids[3]);

    await runMineruBatch(host, ids, false, batchId);

    expect(mineruSubmit).toHaveBeenCalledTimes(3);
    const [tone, text] = host.flash.mock.calls.at(-1)!;
    expect(tone).toBe("error");
    expect(text).toContain("已暂停剩余 1 篇");
    expect((await paperOf(ids[3])).mineruStatus).toBe("cancelled");
    expect(await paperOf(ids[4])).toMatchObject({ mineruStatus: "error", mineruError: PAUSED_ERROR });
  });
});

describe("AI 补全回填", () => {
  async function makeParsed(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) ids.push(await makePaper({ status: "done" }, `# 全文 ${i}`));
    return ids;
  }

  it("回填为已解析未补全的论文补全并提示", async () => {
    const ids = await makeParsed(2);
    const host = makeHost();

    enqueueBackfill(host);
    await settle();

    expect(host.prepare).toHaveBeenCalledTimes(2);
    for (const id of ids) {
      expect(host.prepare).toHaveBeenCalledWith(id, false, true);
      expect((await paperOf(id)).llmPreparedAt).not.toBeNull();
    }
    expect(host.flash).toHaveBeenCalledWith("ok", "已为 2 篇论文补全信息。阅读状态未改动。");
  });

  it("回填连续失败 3 篇即暂停并提示；连续两次入链只跑一遍", async () => {
    const ids = await makeParsed(5);
    // 补全每次都失败：llm_prepared_at 从不写入（Key 错 / 本地模型没启动）。
    const host = makeHost({ prepare: async () => undefined });

    enqueueBackfill(host);
    enqueueBackfill(host);
    await settle();

    expect(host.prepare).toHaveBeenCalledTimes(3);
    expect(host.flash).toHaveBeenCalledTimes(1);
    const [tone, text] = host.flash.mock.calls[0];
    expect(tone).toBe("error");
    expect(text).toContain("AI 补全连续失败 3 篇");
    const metaBatches = getActivity().batches.filter((batch) => batch.kind === "meta");
    expect(metaBatches).toHaveLength(1);
    expect(metaBatches[0].state).toBe("halted");
    expect(Object.values(metaBatches[0].results)).toEqual(["fail", "fail", "fail"]);
    for (const id of ids) expect((await paperOf(id)).llmPreparedAt).toBeNull();
  });
});

describe("作业实况（作业面板的数据来源）", () => {
  it("批次登记 → 逐篇结果 → 正常结束；作业结束后移出实况并计入本次完成", async () => {
    const id = await makePaper();
    const host = makeHost({ hasKey: false });
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ status: "done" }));
    vi.mocked(mineruMarkdown).mockResolvedValue("# md");

    await runMineruBatch(host, [id], false);

    const [batch] = getActivity().batches;
    expect(batch).toMatchObject({ kind: "mineru", state: "done", results: { [id]: "ok" }, currentPaperId: null });
    expect(getActivity().jobs).toEqual({});
    expect(getActivity().tally.done).toBe(1);
    expect((await jobsOf(id)).map((job) => job.status)).toEqual(["done"]);
  });

  it("轮询推进阶段：提交（未定源）→ 解析（实际来源 + 官方 API 页进度）→ 取回全文", async () => {
    const id = await makePaper();
    const host = makeHost({ hasKey: false });
    vi.mocked(mineruSubmit).mockResolvedValue(
      submitResult({ provider: "api", parseIds: [], shortId: "batch-1", status: "running" }),
    );
    const second = hang<MineruParsePoll[]>();
    vi.mocked(mineruParseStatuses)
      .mockResolvedValueOnce([poll("parsing", { id, progress: "3/10" })])
      .mockReturnValueOnce(second.promise);
    vi.mocked(mineruMarkdown).mockResolvedValue("# md");
    const stages: string[] = [];
    const off = subscribeActivity(() => {
      const [live] = Object.values(getActivity().jobs);
      if (live && stages.at(-1) !== live.stage) stages.push(live.stage);
    });

    const run = runMineruBatch(host, [id], false);
    await vi.waitFor(() => expect(mineruParseStatuses).toHaveBeenCalledTimes(2));
    // 第一次轮询后停在解析阶段：来源与页进度已写入实况，批次当前篇为这篇。
    const [live] = Object.values(getActivity().jobs);
    expect(live).toMatchObject({ paperId: id, stage: "parse", provider: "api", pages: { done: 3, total: 10 } });
    expect(getActivity().batches[0].currentPaperId).toBe(id);
    expect((await paperOf(id)).mineruStatus).toBe("parsing");
    expect(await repo.jobStatus(live.jobId)).toBe("running");
    second.release([poll("done", { id, progress: "10/10" })]);
    await run;
    off();

    expect(stages).toEqual(["submit", "parse", "fetch"]);
    expect(getActivity().jobs).toEqual({});
  });

  it("失败计入本次失败；连续失败熔断后批次记为 halted，剩余论文没有结果", async () => {
    const ids = [await makePaper(), await makePaper(), await makePaper(), await makePaper()];
    const host = makeHost();
    vi.mocked(mineruSubmit).mockRejectedValue(new Error("busy"));

    await runMineruBatch(host, ids, false);

    const [batch] = getActivity().batches;
    expect(batch.state).toBe("halted");
    expect(batch.results).toEqual({ [ids[0]]: "fail", [ids[1]]: "fail", [ids[2]]: "fail" });
    expect(getActivity().tally.failed).toBe(3);
  });

  it("enqueueMineruBatch 入链即登记为等待，轮到后开始并跑完", async () => {
    const id = await makePaper();
    const host = makeHost({ hasKey: false });
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ status: "done" }));
    vi.mocked(mineruMarkdown).mockResolvedValue("# md");

    enqueueMineruBatch(host, [id], false);
    expect(getActivity().batches[0]).toMatchObject({ state: "waiting", paperIds: [id] });

    await settle();
    expect(getActivity().batches[0]?.state).toBe("done");
    expect(mineruSubmit).toHaveBeenCalledTimes(1);
    expect((await paperOf(id)).mineruStatus).toBe("done");
  });

  it("解析源已全部停用：预登记的批次直接作废，不留结果小结", async () => {
    const id = await makePaper();
    const host = makeHost({ configured: false });
    const batchId = queueBatch("mineru", [id]);

    await runMineruBatch(host, [id], false, batchId);

    expect(getActivity().batches).toEqual([]);
    expect(mineruSubmit).not.toHaveBeenCalled();
    expect(await jobsOf(id)).toEqual([]);
  });
});
