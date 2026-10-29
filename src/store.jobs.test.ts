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

import { beginBatchItem, getActivity, queueBatch, resetActivity, startBatch } from "./lib/activity";
import { runTracked } from "./lib/jobs";
import { repo } from "./lib/repo";
import { cancelChat, completeChat } from "./lib/settings";
import { allowEveryNote } from "./lib/readingHolds";
import { NOTE_KINDS } from "./lib/types";
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
    const run = useField.getState().runDraftNotes(id, allowEveryNote());
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
    await useField.getState().runDraftNotes(id, allowEveryNote());
    expect((await repo.getPaper(id))!.notes.summary.content).toBe("");
    expect(getActivity().tally.cancelled).toBe(1);
  });

  it("双击起草只跑一个作业", async () => {
    const id = await makePaper();
    const reply = deferred<string>();
    vi.mocked(completeChat).mockReturnValue(reply.promise);
    const first = useField.getState().runDraftNotes(id, allowEveryNote());
    const second = useField.getState().runDraftNotes(id, allowEveryNote());
    reply.resolve('{"summary":"s"}');
    await Promise.all([first, second]);
    expect(vi.mocked(completeChat)).toHaveBeenCalledTimes(1);
  });

  it("stores proposals and writes only from settleNoteReview", async () => {
    const id = await makePaper();
    vi.mocked(completeChat).mockResolvedValue('{"summary":"新总结","highlights":"新亮点"}');
    const apply = vi.spyOn(repo, "applyDraftedNotes");
    await useField.getState().runDraftNotes(id, allowEveryNote());
    expect(apply).not.toHaveBeenCalled();
    expect((await repo.getPaper(id))!.notes.summary.content).toBe("");
    const summary = useField.getState().noteReview?.proposals.find((item) => item.kind === "summary");
    expect(summary).toMatchObject({ before: "", after: "新总结" });
    expect(summary!.rev).toBeGreaterThanOrEqual(0);

    await useField.getState().settleNoteReview({ accept: ["summary"] });
    expect(apply).toHaveBeenCalledTimes(1);
    const revs = apply.mock.calls[0][3] as Record<string, number>;
    expect(revs.summary).toBe(summary!.rev);
    for (const kind of NOTE_KINDS) {
      if (kind !== "summary") expect(revs[kind]).toBe(-1);
    }
    expect((await repo.getPaper(id))!.notes.summary.content).toBe("新总结");
    expect((await repo.getPaper(id))!.notes.highlights.content).toBe("");
    const pending = useField.getState().noteReview?.proposals.map((item) => item.kind);
    expect(pending).not.toContain("summary");
    expect(pending).toContain("highlights");

    await useField.getState().settleNoteReview({ skip: ["highlights"] });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(useField.getState().noteReview?.proposals.map((item) => item.kind)).not.toContain("highlights");
    expect((await repo.getPaper(id))!.notes.highlights.content).toBe("");
    apply.mockRestore();
  });

  it("keeps a kind pending when a draft or a user edit appears before accept", async () => {
    const id = await makePaper();
    vi.mocked(completeChat).mockResolvedValue('{"summary":"新总结","highlights":"新亮点","remarks":"注"}');
    await useField.getState().runDraftNotes(id, allowEveryNote());
    useField.getState().setNoteDraft(id, "summary", "我的草稿");
    await repo.updateNote(id, "highlights", "手写", "manual", true);
    const apply = vi.spyOn(repo, "applyDraftedNotes");
    await useField.getState().settleNoteReview({ accept: ["summary", "highlights", "remarks"] });
    const revs = apply.mock.calls[0][3] as Record<string, number>;
    expect(revs.summary).toBe(-1);
    expect(revs.highlights).toBe(-1);
    expect(revs.remarks).toBeGreaterThanOrEqual(0);
    const paper = (await repo.getPaper(id))!;
    expect(paper.notes.summary.content).toBe("");
    expect(paper.notes.highlights.content).toBe("手写");
    expect(paper.notes.remarks.content).toBe("注");
    const left = useField.getState().noteReview?.proposals.map((item) => item.kind);
    expect(left).toContain("summary");
    expect(left).toContain("highlights");
    expect(left).not.toContain("remarks");
    apply.mockRestore();
  });

  it("drops an open draft and a user-edited block before they become proposals", async () => {
    const id = await makePaper();
    await repo.updateNote(id, "highlights", "手写", "manual", true);
    useField.getState().setNoteDraft(id, "summary", "草稿");
    vi.mocked(completeChat).mockResolvedValue('{"summary":"新总结","highlights":"新亮点","remarks":"注"}');
    await useField.getState().runDraftNotes(id, allowEveryNote());
    const kinds = useField.getState().noteReview?.proposals.map((item) => item.kind);
    expect(kinds).not.toContain("summary");
    expect(kinds).not.toContain("highlights");
    expect(kinds).toContain("remarks");
  });

  it("accepts every current proposal in one write and then goes idle", async () => {
    const id = await makePaper();
    vi.mocked(completeChat).mockResolvedValue('{"summary":"新总结"}');
    const apply = vi.spyOn(repo, "applyDraftedNotes");
    await useField.getState().runDraftNotes(id, allowEveryNote());
    const kinds = useField.getState().noteReview!.proposals.map((item) => item.kind);
    await useField.getState().settleNoteReview({ accept: kinds });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(useField.getState().noteReview).toBeNull();
    expect((await repo.getPaper(id))!.notes.summary.content).toBe("新总结");
    apply.mockRestore();
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

  it("AI 补全批次也能停止：排队论文移出", async () => {
    const batchId = queueBatch("meta", ["p1", "p2"]);
    startBatch(batchId);
    beginBatchItem(batchId, "p1");
    await useField.getState().stopMineruBatch(batchId);
    expect(getActivity().batches[0].results).toEqual({ p2: "cancelled" });
    expect(useField.getState().flash?.text).toBe("已停止补全，2 篇不再写入。");
  });

  it("删除论文先取消它的在途作业", async () => {
    const id = await makePaper();
    const reply = deferred<string>();
    vi.mocked(completeChat).mockReturnValue(reply.promise);
    const run = useField.getState().runDraftNotes(id, allowEveryNote());
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
