import { describe, expect, it } from "vitest";
import type { ActivityBatch, ActivityState, JobLive } from "./activity";
import {
  HISTORY_LIMIT,
  deriveJobsView,
  formatClock,
  formatElapsed,
  formatEta,
  formatSpan,
  stepsFor,
} from "./jobsView";
import type { LlmJob, PaperBrief } from "./types";

const NOW = Date.parse("2026-10-08T10:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function job(overrides: Partial<LlmJob> & Pick<LlmJob, "id" | "paperId">): LlmJob {
  return {
    type: "mineruParse",
    status: "done",
    prompt: null,
    resultJson: null,
    error: null,
    createdAt: iso(60_000),
    startedAt: iso(60_000),
    finishedAt: null,
    paperTitle: `Title ${overrides.paperId}`,
    paperTitleZh: null,
    domainId: "d-1",
    domainName: "多模态",
    domainCode: "MM-01",
    ...overrides,
  };
}

function batch(overrides: Partial<ActivityBatch> & Pick<ActivityBatch, "id" | "paperIds">): ActivityBatch {
  return {
    kind: "mineru",
    results: {},
    currentPaperId: null,
    currentStartedAt: null,
    durations: [],
    queuedAt: NOW - 120_000,
    startedAt: NOW - 120_000,
    finishedAt: null,
    state: "running",
    ...overrides,
  };
}

function activity(overrides: Partial<ActivityState> = {}): ActivityState {
  return {
    batches: [],
    jobs: {},
    tally: { done: 0, failed: 0, cancelled: 0 },
    sessionStartedAt: NOW - 3_600_000,
    ...overrides,
  };
}

function live(overrides: Partial<JobLive> & Pick<JobLive, "jobId" | "paperId" | "stage">): JobLive {
  return { stageAt: NOW - 10_000, provider: null, pages: null, auto: false, ...overrides };
}

describe("stepsFor", () => {
  it("MinerU 三段：提交 → 解析 → 取回全文，当前之前为已完成", () => {
    expect(stepsFor("mineruParse", "parse").map((s) => `${s.label}:${s.state}`)).toEqual([
      "提交:done",
      "解析:current",
      "取回全文:todo",
    ]);
  });

  it("AI 三段：排队 → 请求模型 → 写入结果", () => {
    expect(stepsFor("draftNotes", "apply").map((s) => s.state)).toEqual(["done", "done", "current"]);
  });
});

describe("deriveJobsView · 进行中", () => {
  it("以持久状态为准列出进行中作业：运行中在前，实况补阶段 / 解析源 / 页进度", () => {
    const jobs = [
      job({ id: "q", paperId: "p3", type: "draftNotes", status: "queued", createdAt: iso(5_000), startedAt: null }),
      job({ id: "m", paperId: "p1", status: "running", startedAt: iso(90_000) }),
      job({ id: "old", paperId: "p9", status: "done" }),
    ];
    const view = deriveJobsView({
      jobs,
      activity: activity({
        jobs: { m: live({ jobId: "m", paperId: "p1", stage: "parse", provider: "api", pages: { done: 12, total: 30 } }) },
      }),
      now: NOW,
    });
    expect(view.active.map((a) => a.id)).toEqual(["m", "q"]);
    const [mineru, queued] = view.active;
    expect(mineru).toMatchObject({
      stage: "parse",
      provider: "官方 API",
      pages: { done: 12, total: 30 },
      stageHint: "已解析 12 / 30 页",
      elapsedMs: 90_000,
      stageElapsedMs: 10_000,
      title: "Title p1",
      domainName: "多模态",
    });
    // 无实况的排队 AI 作业：推断为「排队」阶段，用时自创建起算。
    expect(queued).toMatchObject({ stage: "queue", stageHint: "等待开始", elapsedMs: 5_000, stageElapsedMs: null });
    expect(view.counts).toMatchObject({ running: 1, queued: 1 });
    expect(view.busy).toBe(true);
  });

  it("实况里已取消的作业（持久状态已是 cancelled）立即离开进行中", () => {
    const view = deriveJobsView({
      jobs: [job({ id: "m", paperId: "p1", status: "cancelled", error: "cancelled", finishedAt: iso(1_000) })],
      activity: activity({ jobs: { m: live({ jobId: "m", paperId: "p1", stage: "parse" }) } }),
      now: NOW,
    });
    expect(view.active).toEqual([]);
    expect(view.busy).toBe(false);
  });

  it("提交阶段未定源时说明按回退顺序选择；AI 写入阶段按作业类型说明写什么", () => {
    const view = deriveJobsView({
      jobs: [
        job({ id: "m", paperId: "p1", status: "running" }),
        job({ id: "n", paperId: "p2", type: "draftNotes", status: "running" }),
      ],
      activity: activity({
        jobs: {
          m: live({ jobId: "m", paperId: "p1", stage: "submit" }),
          n: live({ jobId: "n", paperId: "p2", stage: "apply" }),
        },
      }),
      now: NOW,
    });
    expect(view.active.find((a) => a.id === "m")?.stageHint).toBe("按回退顺序选择解析源并上传 PDF");
    expect(view.active.find((a) => a.id === "n")?.stageHint).toBe("写入阅读笔记");
  });
});

describe("deriveJobsView · 批次与排队", () => {
  it("运行中批次：逐篇色块、计数、按平均耗时估算剩余时间", () => {
    const b = batch({
      id: 1,
      paperIds: ["p1", "p2", "p3", "p4", "p5"],
      results: { p1: "ok", p2: "fail" },
      durations: [60_000, 40_000],
      currentPaperId: "p3",
      currentStartedAt: NOW - 20_000,
    });
    const view = deriveJobsView({ jobs: [], activity: activity({ batches: [b] }), now: NOW });
    expect(view.batch).toMatchObject({
      label: "MinerU 解析",
      total: 5,
      processed: 2,
      ok: 1,
      fail: 1,
      pending: 2,
      percent: 40,
      elapsedMs: 120_000,
      // 平均 50s：当前篇还剩 30s + 2 篇排队 × 50s。
      etaMs: 130_000,
    });
    expect(view.batch?.segments.map((s) => s.state)).toEqual(["ok", "fail", "current", "pending", "pending"]);
    expect(view.queue.map((q) => q.paperId)).toEqual(["p4", "p5"]);
    expect(view.counts.queued).toBe(2);
  });

  it("等待中的批次论文接在运行批次之后排队；同一篇不重复、已有进行中作业的不列入", () => {
    const view = deriveJobsView({
      jobs: [job({ id: "m", paperId: "p5", status: "running" })],
      activity: activity({
        batches: [
          batch({ id: 1, paperIds: ["p1", "p2"], currentPaperId: "p1" }),
          batch({ id: 2, paperIds: ["p2", "p3", "p5"], state: "waiting", startedAt: null }),
        ],
      }),
      now: NOW,
    });
    expect(view.queue.map((q) => [q.paperId, q.waiting])).toEqual([
      ["p2", false],
      ["p3", true],
    ]);
    expect(view.waitingBatches).toEqual({ count: 1, papers: 3 });
  });

  it("没有运行中批次时展示最近结束的一批；熔断后未处理的论文显示为已暂停、不再估算", () => {
    const view = deriveJobsView({
      jobs: [],
      activity: activity({
        batches: [
          batch({ id: 1, paperIds: ["a"], results: { a: "ok" }, state: "done", finishedAt: NOW - 600_000 }),
          batch({
            id: 2,
            paperIds: ["p1", "p2", "p3"],
            results: { p1: "fail" },
            durations: [10_000],
            state: "halted",
            finishedAt: NOW - 1_000,
          }),
        ],
      }),
      now: NOW,
    });
    expect(view.batch).toMatchObject({ id: 2, state: "halted", etaMs: null, elapsedMs: 119_000 });
    expect(view.batch?.segments.map((s) => s.state)).toEqual(["fail", "paused", "paused"]);
    expect(view.queue).toEqual([]);
    expect(view.busy).toBe(false);
  });

  it("标题优先取轻量书目（中文标题优先），其次作业行，最后用短编号兜底", () => {
    const briefs: Record<string, PaperBrief> = {
      p1: { id: "p1", title: "English", titleZh: "中文标题", domainId: "d-2", domainName: "指令对齐", domainCode: "AL-02" },
    };
    const view = deriveJobsView({
      jobs: [job({ id: "x", paperId: "p2", status: "done", paperTitleZh: "作业里的标题" })],
      activity: activity({ batches: [batch({ id: 1, paperIds: ["p1", "p2", "abcd-ef01"] })] }),
      briefs,
      now: NOW,
    });
    expect(view.queue.map((q) => q.title)).toEqual(["中文标题", "作业里的标题", "论文 ABCD"]);
    expect(view.queue[0]).toMatchObject({ domainId: "d-2", domainName: "指令对齐" });
  });
});

describe("deriveJobsView · 最近结束", () => {
  it("按结束时间倒序、截断到上限；失败 / 取消给出原因，替换类取消单独说明", () => {
    const jobs = [
      job({ id: "a", paperId: "p1", status: "done", startedAt: iso(100_000), finishedAt: iso(40_000) }),
      job({ id: "b", paperId: "p2", status: "error", error: "Token 过期", finishedAt: iso(10_000) }),
      job({ id: "c", paperId: "p3", status: "cancelled", error: "replaced", finishedAt: iso(20_000) }),
      job({ id: "d", paperId: "p4", type: "prepareMeta", status: "cancelled", error: "cancelled", finishedAt: iso(30_000) }),
    ];
    const view = deriveJobsView({ jobs, activity: activity(), now: NOW });
    expect(view.history.map((h) => [h.id, h.note])).toEqual([
      ["b", "Token 过期"],
      ["c", "已被新的解析作业替换"],
      ["d", "已取消"],
      ["a", null],
    ]);
    expect(view.history.find((h) => h.id === "a")?.durationMs).toBe(60_000);

    const many = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) =>
      job({ id: `h${i}`, paperId: `p${i}`, finishedAt: iso(i * 1_000) }),
    );
    expect(deriveJobsView({ jobs: many, activity: activity(), now: NOW }).history).toHaveLength(HISTORY_LIMIT);
  });

  it("只有该篇最近一次 MinerU 作业失败 / 被取消、且不在队列或运行中时才可重新解析", () => {
    const jobs = [
      // p1：旧失败已被后来的成功覆盖 → 不可重试。
      job({ id: "p1-old", paperId: "p1", status: "error", createdAt: iso(300_000), finishedAt: iso(200_000) }),
      job({ id: "p1-new", paperId: "p1", status: "done", createdAt: iso(100_000), finishedAt: iso(50_000) }),
      // p2：最近一次失败 → 可重试。
      job({ id: "p2", paperId: "p2", status: "error", finishedAt: iso(40_000) }),
      // p3：被替换的取消不提供重试。
      job({ id: "p3", paperId: "p3", status: "cancelled", error: "replaced", finishedAt: iso(30_000) }),
      // p4：失败但已重新排队 → 不重复提交。
      job({ id: "p4", paperId: "p4", status: "error", finishedAt: iso(20_000) }),
      // p5：用户取消 → 可重新解析。
      job({ id: "p5", paperId: "p5", status: "cancelled", error: "cancelled", finishedAt: iso(10_000) }),
      // p6：AI 作业失败不在这里重试（可能覆盖手改字段，交给资料栏的确认流程）。
      job({ id: "p6", paperId: "p6", type: "prepareMeta", status: "error", finishedAt: iso(5_000) }),
    ];
    const view = deriveJobsView({
      jobs,
      activity: activity({ batches: [batch({ id: 1, paperIds: ["p4"], state: "waiting" })] }),
      now: NOW,
    });
    const retryable = view.history.filter((h) => h.retryable).map((h) => h.id);
    expect(retryable.sort()).toEqual(["p2", "p5"]);
  });

  it("会话计数直接取实况 tally", () => {
    const view = deriveJobsView({
      jobs: [],
      activity: activity({ tally: { done: 4, failed: 1, cancelled: 2 } }),
      now: NOW,
    });
    expect(view.counts).toEqual({ running: 0, queued: 0, done: 4, failed: 1, cancelled: 2 });
  });
});

describe("格式化", () => {
  it("formatElapsed：mm:ss，满一小时 h:mm:ss", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(65_400)).toBe("01:05");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
  });

  it("formatSpan：口语化用时", () => {
    expect(formatSpan(39_000)).toBe("39 秒");
    expect(formatSpan(100_000)).toBe("1 分 40 秒");
    expect(formatSpan(120_000)).toBe("2 分");
    expect(formatSpan(3_900_000)).toBe("1 小时 5 分");
  });

  it("formatEta：估算值不给秒级精度", () => {
    expect(formatEta(30_000)).toBe("不到 1 分钟");
    expect(formatEta(330_000)).toBe("约 6 分钟");
    expect(formatEta(3_600_000)).toBe("约 1 小时");
    expect(formatEta(5_400_000)).toBe("约 1 小时 30 分钟");
  });

  it("formatClock：今天只给时分，其余日期带月日", () => {
    const today = new Date(NOW);
    today.setHours(9, 5, 0, 0);
    expect(formatClock(today.toISOString(), NOW)).toBe("09:05");
    const earlier = new Date(NOW);
    earlier.setDate(earlier.getDate() - 3);
    earlier.setHours(23, 40, 0, 0);
    const mm = String(earlier.getMonth() + 1).padStart(2, "0");
    const dd = String(earlier.getDate()).padStart(2, "0");
    expect(formatClock(earlier.toISOString(), NOW)).toBe(`${mm}-${dd} 23:40`);
    expect(formatClock(null, NOW)).toBe("—");
  });
});
