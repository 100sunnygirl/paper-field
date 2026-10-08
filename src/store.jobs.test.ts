// 作业面板背后的 store 接线：AI 作业的阶段实况、会话计数，以及「移出队列 / 停止批次」。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmJob, PaperDetail } from "./lib/types";

vi.mock("./lib/repo", () => ({
  repo: {
    getPaper: vi.fn(async () => null),
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    createJob: vi.fn(async (paperId: string, type: string) => ({ id: "job-ai", paperId, type, status: "queued" })),
    updateJob: vi.fn(async () => undefined),
    applyPreparedMeta: vi.fn(async () => undefined),
    setMineruState: vi.fn(async () => undefined),
  },
}));

vi.mock("./lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/settings")>()),
  completeChat: vi.fn(),
  cancelChat: vi.fn(async () => undefined),
}));

vi.mock("./lib/mineruRun", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/mineruRun")>()),
  cancelMineruPaper: vi.fn(),
}));

import { getActivity, beginBatchItem, queueBatch, resetActivity, startBatch } from "./lib/activity";
import { cancelMineruPaper } from "./lib/mineruRun";
import { repo } from "./lib/repo";
import { completeChat } from "./lib/settings";
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

function paper(id: string): PaperDetail {
  return {
    id,
    domainId: "d-1",
    title: `Title ${id}`,
    titleZh: null,
    abstract: "",
    year: null,
    venue: null,
    doi: null,
    arxivId: null,
    pdfUrl: null,
    pdfPath: null,
    codeUrl: null,
    codeOpenSource: "unknown",
    projectPage: null,
    readingStatus: "unread",
    readAt: null,
    llmPreparedAt: null,
    notesDraftedByLlm: false,
    userNotesTouched: false,
    userMetaTouched: false,
    mineruStatus: null,
    mineruParseId: null,
    mineruDocRef: null,
    mineruError: null,
    mineruParseIds: [],
    mineruProvider: null,
    tags: [],
    labs: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    authors: [],
    notes: {} as PaperDetail["notes"],
    domain: {} as PaperDetail["domain"],
    parsedMarkdown: "",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
  useField.setState({ settings: usableSettings });
  resetActivity();
  vi.mocked(repo.getPaper).mockImplementation(async (id: string) => paper(id));
  vi.mocked(repo.updateJob).mockClear();
  vi.mocked(cancelMineruPaper).mockClear();
  vi.mocked(completeChat).mockReset();
});

afterEach(() => {
  act(() => dismissAll("manual"));
});

describe("AI 作业的阶段实况", () => {
  it("请求模型 → 写入结果 → 结束：静默补全标注自动，完成计入本次完成", async () => {
    const reply = deferred<string>();
    vi.mocked(completeChat).mockReturnValue(reply.promise);

    const run = useField.getState().runPrepareMeta("p-1", false, true);
    await vi.waitFor(() => expect(getActivity().jobs["job-ai"]?.stage).toBe("request"));
    expect(getActivity().jobs["job-ai"]).toMatchObject({ paperId: "p-1", auto: true });

    reply.resolve('{"title":"Real Title","abstract":"","authors":[]}');
    await run;

    expect(repo.applyPreparedMeta).toHaveBeenCalled();
    expect(getActivity().jobs).toEqual({});
    expect(getActivity().tally).toEqual({ done: 1, failed: 0, cancelled: 0 });
  });

  it("模型报错：作业移出实况并计入本次失败", async () => {
    vi.mocked(completeChat).mockRejectedValue(new Error("LLM HTTP 429"));
    await useField.getState().runPrepareMeta("p-1");
    expect(getActivity().jobs).toEqual({});
    expect(getActivity().tally.failed).toBe(1);
  });

  it("请求中取消：计入本次取消，不计失败", async () => {
    const reply = deferred<string>();
    vi.mocked(completeChat).mockReturnValue(reply.promise);
    const run = useField.getState().runDraftNotes("p-1");
    await vi.waitFor(() => expect(getActivity().jobs["job-ai"]).toBeDefined());

    await useField.getState().cancelJob("job-ai");
    reply.reject(new Error("aborted"));
    await run;

    expect(getActivity().tally).toEqual({ done: 0, failed: 0, cancelled: 1 });
  });
});

describe("作业面板的队列操作", () => {
  it("setJobsOpen 开关作业面板", () => {
    useField.getState().setJobsOpen(true);
    expect(useField.getState().jobsOpen).toBe(true);
    useField.getState().setJobsOpen(false);
    expect(useField.getState().jobsOpen).toBe(false);
  });

  it("移出队列：打取消标记（轮到时跳过），实况立即记为已取消", () => {
    const batchId = queueBatch("mineru", ["p1", "p2"]);
    useField.getState().dequeueMineruPaper(batchId, "p2");
    expect(cancelMineruPaper).toHaveBeenCalledWith("p2");
    expect(getActivity().batches[0].results).toEqual({ p2: "cancelled" });
  });

  it("停止批次：取消当前篇的进行中作业，其余排队论文全部移出", async () => {
    const batchId = queueBatch("mineru", ["p1", "p2", "p3"]);
    startBatch(batchId);
    beginBatchItem(batchId, "p1");
    const running: LlmJob = {
      id: "job-m",
      paperId: "p1",
      type: "mineruParse",
      status: "running",
      prompt: null,
      resultJson: null,
      error: null,
      createdAt: "2026-10-08T10:00:00.000Z",
      startedAt: "2026-10-08T10:00:00.000Z",
      finishedAt: null,
    };
    useField.setState({ jobs: [running] });

    await useField.getState().stopMineruBatch(batchId);

    // 当前篇走既有 cancelJob（MinerU 作业：打标记 + 作业与论文置为已取消）。
    expect(cancelMineruPaper).toHaveBeenCalledWith("p1");
    expect(repo.updateJob).toHaveBeenCalledWith("job-m", expect.objectContaining({ status: "cancelled" }));
    expect(repo.setMineruState).toHaveBeenCalledWith("p1", { status: "cancelled" });
    // 排队论文移出。
    expect(cancelMineruPaper).toHaveBeenCalledWith("p2");
    expect(cancelMineruPaper).toHaveBeenCalledWith("p3");
    expect(getActivity().batches[0].results).toEqual({ p2: "cancelled", p3: "cancelled" });
    expect(useField.getState().flash).toMatchObject({ tone: "ok", text: expect.stringContaining("3 篇不再处理") });
  });

  it("停止批次时当前篇尚未建作业：直接打取消标记", async () => {
    const batchId = queueBatch("mineru", ["p1"]);
    startBatch(batchId);
    beginBatchItem(batchId, "p1");

    await useField.getState().stopMineruBatch(batchId);

    expect(cancelMineruPaper).toHaveBeenCalledWith("p1");
    expect(repo.updateJob).not.toHaveBeenCalled();
  });

  it("AI 补全批次不提供停止（没有可中断的排队机制）", async () => {
    const batchId = queueBatch("meta", ["p1", "p2"]);
    startBatch(batchId);
    await useField.getState().stopMineruBatch(batchId);
    expect(cancelMineruPaper).not.toHaveBeenCalled();
    expect(getActivity().batches[0].results).toEqual({});
  });
});
