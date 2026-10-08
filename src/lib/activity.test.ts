import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FINISHED_BATCH_LIMIT,
  beginBatchItem,
  discardBatch,
  endBatchItem,
  endJob,
  finishBatch,
  getActivity,
  parsePageProgress,
  patchJobLive,
  queueBatch,
  resetActivity,
  startBatch,
  subscribeActivity,
  trackJob,
} from "./activity";

beforeEach(() => {
  resetActivity();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T10:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("批次生命周期", () => {
  it("queue → start → 逐篇 begin/end → finish：记录结果、当前篇与逐篇耗时", () => {
    const id = queueBatch("mineru", ["a", "b", "b", "c"]);
    let batch = getActivity().batches[0];
    // 入链即登记为等待；重复 id 去重。
    expect(batch).toMatchObject({ id, kind: "mineru", state: "waiting", paperIds: ["a", "b", "c"], startedAt: null });

    startBatch(id);
    beginBatchItem(id, "a");
    expect(getActivity().batches[0].currentPaperId).toBe("a");
    vi.advanceTimersByTime(30_000);
    endBatchItem(id, "a", "ok");
    beginBatchItem(id, "b");
    vi.advanceTimersByTime(10_000);
    endBatchItem(id, "b", "fail");
    // 跳过不计入耗时样本（否则会把剩余时间估算拉低）。
    beginBatchItem(id, "c");
    endBatchItem(id, "c", "skip");

    batch = getActivity().batches[0];
    expect(batch.state).toBe("running");
    expect(batch.results).toEqual({ a: "ok", b: "fail", c: "skip" });
    expect(batch.durations).toEqual([30_000, 10_000]);
    expect(batch.currentPaperId).toBeNull();

    finishBatch(id, "done");
    batch = getActivity().batches[0];
    expect(batch.state).toBe("done");
    expect(batch.finishedAt).toBe(Date.now());
  });

  it("finishBatch 清掉当前篇（熔断 / 异常中止时不残留「处理中」）", () => {
    const id = queueBatch("mineru", ["a", "b"]);
    startBatch(id);
    beginBatchItem(id, "a");
    finishBatch(id, "halted");
    expect(getActivity().batches[0]).toMatchObject({ state: "halted", currentPaperId: null, currentStartedAt: null });
  });

  it("已结束批次只保留最近几个，运行中 / 等待中的批次不受影响", () => {
    const ids = Array.from({ length: FINISHED_BATCH_LIMIT + 2 }, (_, i) => {
      const id = queueBatch("mineru", [`p${i}`]);
      startBatch(id);
      finishBatch(id, "done");
      return id;
    });
    const waiting = queueBatch("mineru", ["w"]);
    const kept = getActivity().batches.map((batch) => batch.id);
    expect(kept).toEqual([...ids.slice(-FINISHED_BATCH_LIMIT), waiting]);
  });

  it("discardBatch 直接移除；对不存在的批次各操作均无副作用", () => {
    const id = queueBatch("meta", ["a"]);
    discardBatch(id);
    expect(getActivity().batches).toEqual([]);
    const before = getActivity();
    startBatch(999);
    endBatchItem(999, "a", "ok");
    finishBatch(999, "done");
    discardBatch(999);
    expect(getActivity()).toBe(before);
  });
});

describe("作业实况", () => {
  it("阶段变化重置阶段计时；同阶段补丁只合并、不重置", () => {
    trackJob("j1", "p1", "submit");
    const t0 = Date.now();
    vi.advanceTimersByTime(5_000);
    trackJob("j1", "p1", "parse", { provider: "api" });
    expect(getActivity().jobs.j1).toMatchObject({ stage: "parse", stageAt: t0 + 5_000, provider: "api", auto: false });

    vi.advanceTimersByTime(4_000);
    trackJob("j1", "p1", "parse", { pages: { done: 3, total: 10 } });
    // 同阶段：阶段计时不动，解析源沿用。
    expect(getActivity().jobs.j1).toMatchObject({ stageAt: t0 + 5_000, provider: "api", pages: { done: 3, total: 10 } });

    trackJob("j1", "p1", "fetch");
    // 换阶段：页进度清空（只属于解析阶段），解析源保留。
    expect(getActivity().jobs.j1).toMatchObject({ stage: "fetch", pages: null, provider: "api" });
  });

  it("patchJobLive 值未变时不通知订阅者；未登记作业忽略", () => {
    trackJob("j1", "p1", "parse", { provider: "local" });
    const listener = vi.fn();
    const off = subscribeActivity(listener);
    patchJobLive("j1", { pages: null, provider: "local" });
    expect(listener).not.toHaveBeenCalled();
    patchJobLive("j1", { pages: { done: 1, total: 4 } });
    expect(listener).toHaveBeenCalledTimes(1);
    patchJobLive("nope", { pages: { done: 1, total: 4 } });
    expect(getActivity().jobs.nope).toBeUndefined();
    off();
  });

  it("endJob 移出实况并计入会话计数；同一作业重复结束只计一次", () => {
    trackJob("j1", "p1", "request", { auto: true });
    trackJob("j2", "p2", "request");
    trackJob("j3", "p3", "parse");
    endJob("j1", "done");
    endJob("j1", "error");
    endJob("j2", "error");
    endJob("j3", "cancelled");
    endJob("never-tracked", "done");
    expect(getActivity().jobs).toEqual({});
    expect(getActivity().tally).toEqual({ done: 1, failed: 1, cancelled: 1 });
  });

  it("每次变化都换新的状态对象（可直接作 useSyncExternalStore 快照）", () => {
    const a = getActivity();
    trackJob("j1", "p1", "submit");
    const b = getActivity();
    expect(b).not.toBe(a);
    expect(getActivity()).toBe(b);
  });
});

describe("parsePageProgress", () => {
  it("汇总多个解析项的「已解析/总页数」", () => {
    expect(parsePageProgress(["3/10", " 5 / 20 "])).toEqual({ done: 8, total: 30 });
  });

  it("doclib（null）或总页数为 0 时返回 null", () => {
    expect(parsePageProgress([null, undefined])).toBeNull();
    expect(parsePageProgress(["0/0"])).toBeNull();
    expect(parsePageProgress(["garbage"])).toBeNull();
  });

  it("已解析页数不超过总页数", () => {
    expect(parsePageProgress(["12/10"])).toEqual({ done: 10, total: 10 });
  });
});
