// 作业面板背后的 store 接线：AI 作业的阶段实况、会话计数，以及「移出队列 / 停止批次」。
// 用真实 repo（sql.js 内存库）：作业行、解析状态与所有权都按生产语义落库。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestEngine, type TestEngineHandle } from "./test/helpers";
import type { SqlEngine } from "./lib/engine";

const holder = vi.hoisted(() => ({ engine: null as SqlEngine | null }));
vi.mock("./lib/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/engine")>()),
  getEngine: () => Promise.resolve(holder.engine!),
}));

vi.mock("./lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/settings")>()),
  completeChat: vi.fn(),
  cancelChat: vi.fn(async () => undefined),
}));

vi.mock("./lib/mineru", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/mineru")>()),
  // 默认提交直接失败收场：断言只看 resetMineru 的落库效果；批次把该篇记 fail 后
  // 链自然跑空，不留挂起任务堵住后续用例（挂起语义的用例自行 mockImplementation 覆盖）。
  mineruSubmit: vi.fn(async (): Promise<MineruSubmitResult> => {
    throw new Error("提交失败（测试默认）");
  }),
}));

import { beginBatchItem, endBatchItem, finishBatch, getActivity, queueBatch, resetActivity, startBatch } from "./lib/activity";
import { runTracked } from "./lib/jobs";
import { dequeueFromBatch, enqueueMineru } from "./lib/mineruRun";
import { DEFAULT_MINERU, mineruSubmit, type MineruSubmitResult } from "./lib/mineru";
import { getReparseRecord, resetReparseSnapshots } from "./lib/reparse";
import { repo } from "./lib/repo";
import { cancelChat, completeChat } from "./lib/settings";
import { useField } from "./store";
import { dismissAll } from "./toasts";

const usableSettings = {
  version: 2 as const,
  usage: {},
  providers: [
    {
      id: "a",
      presetId: "deepseek",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      enabled: true,
      hasKey: true,
      requiresKey: true,
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let handle: TestEngineHandle;
let domainId: string;

async function makePaper(pdf = false): Promise<string> {
  const paper = await repo.createPaper({ domainId, title: "T", pdfPath: pdf ? "/papers/a.pdf" : undefined });
  return paper.id;
}

function liveJob() {
  return Object.values(getActivity().jobs)[0];
}

beforeEach(async () => {
  handle = await makeTestEngine();
  holder.engine = handle.engine;
  domainId = (await repo.createDomain({ name: "D", code: "D-01" })).id;
  useField.setState(useField.getInitialState(), true);
  useField.setState({ settings: usableSettings });
  resetActivity();
  resetReparseSnapshots();
  vi.mocked(completeChat).mockReset();
  vi.mocked(cancelChat).mockClear();
});

afterEach(() => {
  act(() => dismissAll("manual"));
  handle.close();
});

describe("AI 作业的阶段实况", () => {
  it("查文献库 → 请求模型 → 写入结果 → 结束：静默补全标注自动，完成计入本次完成", async () => {
    const id = await makePaper();
    const reply = deferred<string>();
    vi.mocked(completeChat).mockReturnValue(reply.promise);

    const run = useField.getState().runPrepareMeta(id, false, true);
    await vi.waitFor(() => expect(vi.mocked(completeChat)).toHaveBeenCalled());
    expect(liveJob()).toMatchObject({ paperId: id, auto: true, stage: "request" });

    reply.resolve('{"titleZh":"中文标题","abstract":"","authors":[]}');
    await run;

    const paper = (await repo.getPaper(id))!;
    expect(paper.titleZh).toBe("中文标题");
    expect(paper.llmPreparedAt).not.toBeNull();
    expect(getActivity().jobs).toEqual({});
    expect(getActivity().tally).toEqual({ done: 1, failed: 0, cancelled: 0 });
    expect((await repo.listJobs())[0].status).toBe("done");
  });

  it("模型报错：作业移出实况并计入本次失败，作业行记为失败", async () => {
    const id = await makePaper();
    vi.mocked(completeChat).mockRejectedValue(new Error("LLM HTTP 429"));
    await useField.getState().runPrepareMeta(id);
    expect(getActivity().jobs).toEqual({});
    expect(getActivity().tally.failed).toBe(1);
    expect((await repo.listJobs())[0]).toMatchObject({ status: "error", error: "LLM HTTP 429" });
  });

  it("请求中取消：计入本次取消，不计失败，也不写笔记", async () => {
    const id = await makePaper();
    const reply = deferred<string>();
    vi.mocked(completeChat).mockReturnValue(reply.promise);
    const run = useField.getState().runDraftNotes(id);
    await vi.waitFor(() => expect(vi.mocked(completeChat)).toHaveBeenCalled());
    const jobId = (await repo.listJobs())[0].id;
    useField.setState({ jobs: await repo.listJobs() });

    await useField.getState().cancelJob(jobId);
    expect(cancelChat).toHaveBeenCalledWith(jobId);
    reply.resolve('{"summary":"迟到的草稿"}');
    await run;

    expect(getActivity().tally).toEqual({ done: 0, failed: 0, cancelled: 1 });
    expect((await repo.getPaper(id))!.notes.summary.content).toBe("");
    expect((await repo.listJobs())[0].status).toBe("cancelled");
  });

  it("回写那一刻被取消：笔记与作业 done 同一个事务，整批不写", async () => {
    const id = await makePaper();
    vi.mocked(completeChat).mockImplementation(async (input) => {
      // 模型返回后、回写之前作业被取消
      await repo.finishJob(input.jobId, "cancelled", { error: "cancelled" });
      return '{"summary":"不该写入"}';
    });
    await useField.getState().runDraftNotes(id);
    expect((await repo.getPaper(id))!.notes.summary.content).toBe("");
    expect(getActivity().tally.cancelled).toBe(1);
  });

  it("双击起草只跑一个作业", async () => {
    const id = await makePaper();
    const reply = deferred<string>();
    vi.mocked(completeChat).mockReturnValue(reply.promise);
    const first = useField.getState().runDraftNotes(id);
    const second = useField.getState().runDraftNotes(id);
    reply.resolve('{"summary":"s"}');
    await Promise.all([first, second]);
    expect(vi.mocked(completeChat)).toHaveBeenCalledTimes(1);
  });
});

describe("作业面板的队列操作", () => {
  it("setJobsOpen 开关作业面板", () => {
    useField.getState().setJobsOpen(true);
    expect(useField.getState().jobsOpen).toBe(true);
    useField.getState().setJobsOpen(false);
    expect(useField.getState().jobsOpen).toBe(false);
  });

  it("移出队列：实况立即记为已取消，库里状态写成 cancelled（重启后不会被续跑）", async () => {
    const p1 = await makePaper(true);
    const p2 = await makePaper(true);
    await repo.resetMineru([p1, p2]);
    const batchId = queueBatch("mineru", [p1, p2]);
    useField.getState().dequeueMineruPaper(batchId, p2);
    await vi.waitFor(async () => expect((await repo.getPaper(p2))!.mineruStatus).toBe("cancelled"));
    expect(getActivity().batches[0].results).toEqual({ [p2]: "cancelled" });
    expect(await repo.listPendingMineru()).toEqual([p1]);
  });

  it("停止批次：取消当前篇的进行中作业，其余排队论文全部移出并落库", async () => {
    const [p1, p2, p3] = [await makePaper(true), await makePaper(true), await makePaper(true)];
    await repo.resetMineru([p1, p2, p3]);
    const batchId = queueBatch("mineru", [p1, p2, p3]);
    startBatch(batchId);
    beginBatchItem(batchId, p1);
    const hang = deferred<"done" | "cancelled">();
    let signal: AbortSignal | null = null;
    const run = runTracked(
      { type: "mineruParse", paperId: p1, prompt: null, stage: "parse", claimMineru: { resume: false } },
      async (ctx) => {
        signal = ctx.signal;
        return hang.promise;
      },
    );
    await vi.waitFor(() => expect(signal).not.toBeNull());

    await useField.getState().stopMineruBatch(batchId);

    expect(signal!.aborted).toBe(true);
    hang.resolve("cancelled");
    await run;
    expect((await repo.listJobs())[0].status).toBe("cancelled");
    for (const id of [p1, p2, p3]) expect((await repo.getPaper(id))!.mineruStatus).toBe("cancelled");
    expect(getActivity().batches[0].results).toEqual({ [p2]: "cancelled", [p3]: "cancelled" });
    expect(useField.getState().flash?.text).toBe(
      "已在本机停止解析，3 篇不再写入。远端任务不撤回，可能仍在继续，配额或页数可能已经计入。",
    );
  });

  it("重新解析已有全文：先弹确认对话框，确认后快照旧版并强制重提", async () => {
    const id = await makePaper(true);
    await repo.setMineruState(id, { status: "done", provider: "api" });
    await repo.saveParsedMarkdown(id, "# 旧版全文");
    useField.setState({
      mineru: { ...DEFAULT_MINERU, ssh: { ...DEFAULT_MINERU.ssh, enabled: true }, configured: true },
      effectiveProvider: "ssh",
    });

    await useField.getState().retryMineru(id);

    // 已有全文：先弹「确认重新解析」，不直接提交。
    expect(useField.getState().dialog).toBe("confirm-reparse");
    expect(useField.getState().dialogPaperId).toBe(id);
    expect(vi.mocked(mineruSubmit)).not.toHaveBeenCalled();

    await useField.getState().confirmReparse();

    // 确认后：旧版（含上次用的源）已快照，解析状态重置为 queued 并入链强制重提。
    expect(getReparseRecord(id)?.prev).toMatchObject({ provider: "api", markdown: "# 旧版全文" });
    expect((await repo.getPaper(id))!.mineruStatus).toBe("queued");
    expect(useField.getState().flash?.text).toContain("对照新旧两版");
    await vi.waitFor(() => expect(vi.mocked(mineruSubmit)).toHaveBeenCalled());
  });

  it("没有全文时 retryMineru 不弹确认，直接提交", async () => {
    const id = await makePaper(true);
    useField.setState({
      mineru: { ...DEFAULT_MINERU, ssh: { ...DEFAULT_MINERU.ssh, enabled: true }, configured: true },
      effectiveProvider: "ssh",
    });

    await useField.getState().retryMineru(id);

    expect(useField.getState().dialog).toBeNull();
    expect(useField.getState().flash?.text).toContain("已将这篇论文发送到 MinerU 解析");
    await vi.waitFor(() => expect(vi.mocked(mineruSubmit)).toHaveBeenCalled());
  });

  it("仅停止未提交：排队论文写 cancelled、当前篇不动，提示带一键重新排队", async () => {
    const [p1, p2, p3] = [await makePaper(true), await makePaper(true), await makePaper(true)];
    await repo.resetMineru([p1, p2, p3]);
    const batchId = queueBatch("mineru", [p1, p2, p3]);
    startBatch(batchId);
    beginBatchItem(batchId, p1);
    const retryMineruPapers = vi.fn(async () => undefined);
    useField.setState({ retryMineruPapers });

    await useField.getState().stopMineruBatchUnsubmitted(batchId);

    expect(getActivity().batches[0].results).toEqual({ [p2]: "cancelled", [p3]: "cancelled" });
    expect((await repo.getPaper(p2))!.mineruStatus).toBe("cancelled");
    expect((await repo.getPaper(p1))!.mineruStatus).toBe("queued");
    const flash = useField.getState().flash;
    expect(flash?.text).toContain("已移出 2 篇排队论文，正在解析的一篇继续收尾");
    expect(flash?.text).toContain("远端任务不撤回");
    expect(flash?.action?.label).toBe("重新排队 2 篇");
    flash?.action?.run();
    await vi.waitFor(() => expect(retryMineruPapers).toHaveBeenCalledWith([p2, p3]));
  });

  it("全部停止的提示也带「一键重新排队」（受影响论文含正在解析的一篇）", async () => {
    const [p1, p2] = [await makePaper(true), await makePaper(true)];
    await repo.resetMineru([p1, p2]);
    const batchId = queueBatch("mineru", [p1, p2]);
    startBatch(batchId);
    beginBatchItem(batchId, p1);
    const retryMineruPapers = vi.fn(async () => undefined);
    useField.setState({ retryMineruPapers });

    await useField.getState().stopMineruBatch(batchId);

    const flash = useField.getState().flash;
    expect(flash?.text).toBe(
      "已在本机停止解析，2 篇不再写入。远端任务不撤回，可能仍在继续，配额或页数可能已经计入。",
    );
    expect(flash?.action?.label).toBe("重新排队 2 篇");
    flash?.action?.run();
    await vi.waitFor(() => expect(retryMineruPapers).toHaveBeenCalledTimes(1));
  });

  it("submitMineruRetry 单篇覆盖：指定未启用源给指引，启用源则本轮直提", async () => {
    // 前面的用例把解析链堵在挂起的提交上：先放行为失败，让链跑空再测覆盖。
    vi.mocked(mineruSubmit).mockRejectedValue(new Error("blocked"));
    await new Promise<void>((resolve) => enqueueMineru(async () => resolve()));
    vi.mocked(mineruSubmit).mockReset();
    vi.mocked(mineruSubmit).mockImplementation((): Promise<MineruSubmitResult> => new Promise(() => {}));

    const id = await makePaper(true);
    // 只启用官方 API：指定本地应被拦下。
    useField.setState({
      mineru: { ...DEFAULT_MINERU, api: { ...DEFAULT_MINERU.api, hasToken: true }, configured: true },
      effectiveProvider: "api",
    });
    await useField.getState().submitMineruRetry(id, { provider: "local" });
    expect(useField.getState().flash?.tone).toBe("warn");
    expect(useField.getState().flash?.text).toContain("未启用");

    // 指定已启用的官方 API：直接重提，提示写明指定源；提交挂起不断言其后的轮询。
    vi.mocked(mineruSubmit).mockClear();
    await useField.getState().submitMineruRetry(id, { provider: "api" });
    expect((await repo.getPaper(id))!.mineruStatus).toBe("queued");
    expect(useField.getState().flash?.text).toContain("指定官方 API");
    // 提交在后台链上跑（默认失败收场不堵链）；第 4 参 = 指定源。
    await vi.waitFor(() => expect(vi.mocked(mineruSubmit).mock.calls.length).toBeGreaterThanOrEqual(1), 5000);
    const overrideCall = vi.mocked(mineruSubmit).mock.calls.find((call) => call[3] === "api");
    expect(overrideCall).toBeTruthy();
  });

  it("AI 补全批次也能停止：排队论文移出", async () => {
    const batchId = queueBatch("meta", ["p1", "p2"]);
    startBatch(batchId);
    beginBatchItem(batchId, "p1");
    await useField.getState().stopMineruBatch(batchId);
    expect(getActivity().batches[0].results).toEqual({ p2: "cancelled" });
    expect(useField.getState().flash?.text).toBe("已停止补全，2 篇不再写入。");
  });

  it("清空其余：保留下一篇排队论文，其余移出并落库为已取消", async () => {
    const [p1, p2, p3, p4] = [
      await makePaper(true),
      await makePaper(true),
      await makePaper(true),
      await makePaper(true),
    ];
    await repo.resetMineru([p1, p2, p3, p4]);
    const batchId = queueBatch("mineru", [p1, p2, p3, p4]);
    startBatch(batchId);
    beginBatchItem(batchId, p1); // p1 处理中，p2 是下一篇
    await useField.getState().clearQueueRest(batchId);
    expect(getActivity().batches[0].results).toEqual({ [p3]: "cancelled", [p4]: "cancelled" });
    expect(getActivity().batches[0].paperIds).toEqual([p1, p2, p3, p4]);
    for (const id of [p3, p4]) expect((await repo.getPaper(id))!.mineruStatus).toBe("cancelled");
    expect(useField.getState().flash?.text).toBe("已移出 2 篇，保留下一篇继续解析。");
  });

  it("reorderQueue 调整批次内排队顺序（置顶后 p3 排在 p2 前面）", () => {
    const batchId = queueBatch("mineru", ["p1", "p2", "p3"]);
    startBatch(batchId);
    beginBatchItem(batchId, "p1");
    useField.getState().reorderQueue(batchId, "p3", "top");
    expect(getActivity().batches[0].paperIds).toEqual(["p1", "p3", "p2"]);
  });

  it("继续本批：解析源测试通过后只恢复未完成篇（已完成与移出的不动）", async () => {
    const [p1, p2, p3] = [await makePaper(true), await makePaper(true), await makePaper(true)];
    await repo.resetMineru([p1, p2, p3]);
    const batchId = queueBatch("mineru", [p1, p2, p3]);
    startBatch(batchId);
    endBatchItem(batchId, p1, "ok");
    await dequeueFromBatch(batchId, p3); // 被用户移出的：库里也写 cancelled
    finishBatch(batchId, "halted");
    useField.setState({
      mineru: { ...DEFAULT_MINERU, ssh: { ...DEFAULT_MINERU.ssh, enabled: true }, configured: true },
      effectiveProvider: "ssh",
    });

    await useField.getState().resumeHaltedBatch(batchId);

    expect(useField.getState().flash?.tone).toBe("ok");
    expect(useField.getState().flash?.text).toContain("已恢复本批剩余 1 篇");
    expect((await repo.getPaper(p2))!.mineruStatus).toBe("queued");
    expect((await repo.getPaper(p3))!.mineruStatus).toBe("cancelled");
    // 恢复只带未完成的那一篇，作为新批次入链。
    const resumed = getActivity().batches.find((batch) => batch.paperIds.includes(p2) && batch.id !== batchId);
    expect(resumed?.paperIds).toEqual([p2]);
  });

  it("继续本批：解析源全部不可用时不恢复，论文状态不动", async () => {
    const p1 = await makePaper(true);
    const batchId = queueBatch("mineru", [p1]);
    startBatch(batchId);
    finishBatch(batchId, "halted");
    useField.setState({
      mineru: { ...DEFAULT_MINERU, ssh: { ...DEFAULT_MINERU.ssh, enabled: true }, configured: true },
    });

    await useField.getState().resumeHaltedBatch(batchId);

    expect(useField.getState().flash?.tone).toBe("warn");
    expect(useField.getState().flash?.text).toContain("解析源测试未通过");
    expect((await repo.getPaper(p1))!.mineruStatus).toBe("pending");
  });

  it("当前篇完成后暂停：给批次打标记并提示稍后可继续", () => {
    const batchId = queueBatch("mineru", ["p1", "p2"]);
    startBatch(batchId);
    useField.getState().pauseBatchAfterCurrent(batchId);
    expect(useField.getState().flash?.text).toContain("当前一篇完成后暂停本批");
  });

  it("openPaperFulltext：跳到该论文并自动展开「解析全文」折叠区", async () => {
    const id = await makePaper(true);
    await repo.saveParsedMarkdown(id, "# 全文");
    // 阅读页的全文折叠区：挂一个同 id 的 details 模拟挂载后的 DOM。
    const fulltext = document.createElement("details");
    fulltext.id = "fulltext";
    document.body.appendChild(fulltext);
    try {
      await useField.getState().openPaperFulltext(id);
      await vi.waitFor(() => expect(fulltext.hasAttribute("open")).toBe(true));
    } finally {
      fulltext.remove();
    }
    expect(useField.getState().selectedPaperId).toBe(id);
    expect(useField.getState().mode).toBe("field");
  });

  it("openPaperFulltext：论文已删除时静默返回，不切换", async () => {
    useField.setState({ selectedPaperId: "keep" });
    await useField.getState().openPaperFulltext("gone");
    expect(useField.getState().selectedPaperId).toBe("keep");
  });

  it("删除论文先取消它的在途作业", async () => {
    const id = await makePaper();
    const reply = deferred<string>();
    vi.mocked(completeChat).mockReturnValue(reply.promise);
    const run = useField.getState().runDraftNotes(id);
    await vi.waitFor(() => expect(vi.mocked(completeChat)).toHaveBeenCalled());
    useField.setState({ selectedPaperId: id });
    await useField.getState().deletePaper();
    reply.resolve('{"summary":"s"}');
    await run;
    expect(cancelChat).toHaveBeenCalled();
    expect(getActivity().tally.cancelled).toBe(1);
    expect(await repo.getPaper(id)).toBeNull();
  });
});
