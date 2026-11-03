import { act } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmJob, PaperBrief } from "../lib/types";

vi.mock("../lib/repo", () => ({
  repo: {
    init: vi.fn(async () => undefined),
    paperBriefs: vi.fn(async () => [] as PaperBrief[]),
    getPaper: vi.fn(async () => null),
    getDomain: vi.fn(async () => null),
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    listPendingMineru: vi.fn(async () => [] as string[]),
    listReadyForMeta: vi.fn(async () => [] as string[]),
    searchAll: vi.fn(async () => []),
    domainCensus: vi.fn(async () => []),
  },
}));

import App from "../App";
import {
  beginBatchItem,
  endBatchItem,
  finishBatch,
  getActivity,
  queueBatch,
  resetActivity,
  startBatch,
  trackJob,
} from "../lib/activity";
import { journalBegin, journalFinish, journalItem, resetJobJournal } from "../lib/jobJournal";
import { repo } from "../lib/repo";
import { useField } from "../store";
import { JobsPanel } from "./JobsPanel";

function job(overrides: Partial<LlmJob> & Pick<LlmJob, "id" | "paperId">): LlmJob {
  return {
    type: "mineruParse",
    status: "running",
    prompt: null,
    resultJson: null,
    error: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    finishedAt: null,
    paperTitle: `Title ${overrides.paperId}`,
    paperTitleZh: null,
    domainId: "d-1",
    domainName: "多模态",
    domainCode: "MM-01",
    ...overrides,
  };
}

const actions = {
  cancelJob: vi.fn(async () => undefined),
  retryMineru: vi.fn(async () => undefined),
  retryHistoryJob: vi.fn(async () => undefined),
  retryMineruPapers: vi.fn(async () => undefined),
  retryFailedMetaJobs: vi.fn(async () => undefined),
  selectDomain: vi.fn(async () => undefined),
  selectPaper: vi.fn(async () => undefined),
  dequeueMineruPaper: vi.fn(),
  stopMineruBatch: vi.fn(async () => undefined),
  reorderQueue: vi.fn(),
  clearQueueRest: vi.fn(async () => undefined),
  openPaperFulltext: vi.fn(async () => undefined),
  openDialog: vi.fn(),
  pauseBatchAfterCurrent: vi.fn(),
  resumeHaltedBatch: vi.fn(async () => undefined),
};

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
  useField.setState({ ...actions, jobsOpen: true });
  Object.values(actions).forEach((fn) => fn.mockClear());
  resetActivity();
  localStorage.removeItem("paper-field.jobs-queue-expanded");
  localStorage.removeItem("paper-field.job-notify");
  localStorage.removeItem("paper-field.job-journal");
  resetJobJournal();
  vi.mocked(repo.paperBriefs).mockResolvedValue([]);
});

afterEach(() => {
  act(() => resetActivity());
});

describe("JobsPanel", () => {
  it("未打开时不渲染任何节点", () => {
    useField.setState({ jobsOpen: false });
    const { container } = render(<JobsPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("空闲：计数为 0、给出空闲说明，可关闭", () => {
    render(<JobsPanel />);
    const panel = screen.getByRole("dialog", { name: "作业面板" });
    expect(panel).toHaveAttribute("aria-modal", "false");
    expect(within(panel).getByText("空闲")).toBeInTheDocument();
    expect(within(panel).getByText("队列空闲")).toBeInTheDocument();
    expect(within(panel).getByText("还没有结束的作业。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭作业面板" }));
    expect(useField.getState().jobsOpen).toBe(false);
  });

  it("MinerU 作业卡：阶段刻度、解析源、页进度与取消", () => {
    trackJob("m", "p1", "parse", { provider: "api", pages: { done: 12, total: 30 } });
    useField.setState({ jobs: [job({ id: "m", paperId: "p1" })] });
    render(<JobsPanel />);

    const card = screen.getByRole("article", { name: "MinerU 解析：Title p1" });
    expect(within(card).getByText("多模态 · 官方 API")).toBeInTheDocument();
    const steps = within(card).getByRole("list", { name: "作业阶段" });
    expect(within(steps).getByText("解析").closest("li")).toHaveAttribute("aria-current", "step");
    const bar = within(card).getByRole("progressbar", { name: "解析页进度" });
    expect(bar).toHaveAttribute("aria-valuenow", "12");
    expect(bar).toHaveAttribute("aria-valuemax", "30");
    expect(within(card).getByText("已解析 12 / 30 页")).toBeInTheDocument();
    expect(screen.getByText("运行中", { selector: ".ef-jobs-state" })).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "取消" }));
    expect(actions.cancelJob).toHaveBeenCalledWith("m");
  });

  it("进行中卡显示所属批次关联；入库页互跳的高亮落在对应卡上", () => {
    const batchId = queueBatch("mineru", ["p1", "p2", "p3"]);
    startBatch(batchId);
    beginBatchItem(batchId, "p2");
    useField.setState({ jobs: [job({ id: "m", paperId: "p2" })], highlightJobId: "m" });
    render(<JobsPanel />);

    const card = screen.getByRole("article", { name: "MinerU 解析：Title p2" });
    expect(within(card).getByText("多模态 · 本批第 2/3 篇")).toBeInTheDocument();
    expect(card.className).toContain("is-highlight");
  });

  it("AI 作业卡：标注解析后自动，并写出首选提供商与回退数量", () => {
    trackJob("a", "p2", "request", { auto: true });
    useField.setState({
      jobs: [job({ id: "a", paperId: "p2", type: "prepareMeta" })],
      settings: {
        version: 2,
        usage: {},
        providers: [
          { id: "x", presetId: null, label: "DeepSeek", baseUrl: "u", model: "deepseek-chat", enabled: true, hasKey: true, requiresKey: true },
          { id: "y", presetId: null, label: "Ollama", baseUrl: "u", model: "qwen", enabled: true, hasKey: false, requiresKey: false },
          { id: "z", presetId: null, label: "Off", baseUrl: "u", model: "m", enabled: false, hasKey: true, requiresKey: true },
        ],
      },
    });
    render(<JobsPanel />);
    const card = screen.getByRole("article", { name: "补全论文信息：Title p2" });
    expect(within(card).getByText("解析后自动")).toBeInTheDocument();
    expect(within(card).getByText("多模态 · 计划使用 DeepSeek（deepseek-chat） · 失败时回退其余 1 个")).toBeInTheDocument();
    expect(within(card).getByText("请求模型").closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("批次卡：逐篇色块与小结；停止本批需二次确认", async () => {
    const batchId = queueBatch("mineru", ["p1", "p2", "p3"]);
    startBatch(batchId);
    beginBatchItem(batchId, "p1");
    endBatchItem(batchId, "p1", "ok");
    beginBatchItem(batchId, "p2");
    render(<JobsPanel />);

    const card = screen.getByRole("article", { name: "MinerU 解析批次" });
    expect(within(card).getByRole("list", { name: /已处理 1 \/ 3 篇/ })).toBeInTheDocument();
    expect(card.querySelectorAll(".ef-segments li")).toHaveLength(3);
    expect(card.querySelector(".ef-segments li.is-current")).not.toBeNull();
    expect(within(card).getByText("排队 1")).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "停止本批…" }));
    expect(actions.stopMineruBatch).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "确认停止" }));
    expect(actions.stopMineruBatch).toHaveBeenCalledWith(batchId);
  });

  it("批次色块可访问：每格带标题/状态/失败原因的 aria-label，点击跳转该论文", async () => {
    const batchId = queueBatch("mineru", ["p1", "p2", "p3"]);
    startBatch(batchId);
    beginBatchItem(batchId, "p1");
    endBatchItem(batchId, "p1", "fail");
    beginBatchItem(batchId, "p2");
    useField.setState({
      jobs: [
        job({
          id: "e1",
          paperId: "p1",
          status: "error",
          error: "SSH 连接中断",
          finishedAt: new Date().toISOString(),
        }),
      ],
    });
    render(<JobsPanel />);
    const card = screen.getByRole("article", { name: "MinerU 解析批次" });

    const failBlock = within(card).getByRole("button", {
      name: "01 · Title p1 — 失败：SSH 连接中断",
    });
    expect(failBlock).toBeInTheDocument();
    const okBlock = within(card).getByRole("button", { name: "02 · 论文 P2 — 处理中" });
    expect(okBlock).toBeInTheDocument();

    fireEvent.click(failBlock);
    await waitFor(() => expect(actions.selectPaper).toHaveBeenCalledWith("p1"));
  });

  it("逐篇文字列表：可键盘聚焦的替代视图，失败原因成行展示", async () => {
    const batchId = queueBatch("mineru", ["p1", "p2"]);
    startBatch(batchId);
    beginBatchItem(batchId, "p1");
    endBatchItem(batchId, "p1", "fail");
    beginBatchItem(batchId, "p2");
    useField.setState({
      jobs: [job({ id: "e1", paperId: "p1", status: "error", error: "Token 过期", finishedAt: new Date().toISOString() })],
    });
    render(<JobsPanel />);
    const card = screen.getByRole("article", { name: "MinerU 解析批次" });

    fireEvent.click(within(card).getByRole("button", { name: "文字列表" }));
    const list = within(card).getByRole("list", { name: /逐篇列表/ });
    expect(within(list).getByText("Title p1")).toBeInTheDocument();
    expect(within(list).getByText("失败")).toBeInTheDocument();
    expect(within(list).getByText("Token 过期")).toBeInTheDocument();
    expect(within(list).getByText("论文 P2")).toBeInTheDocument();
    expect(within(list).getByText("处理中")).toBeInTheDocument();

    fireEvent.click(within(list).getByRole("button", { name: /Title p1/ }));
    await waitFor(() => expect(actions.selectPaper).toHaveBeenCalledWith("p1"));

    // 切回色块。
    fireEvent.click(within(card).getByRole("button", { name: "色块" }));
    expect(card.querySelector(".ef-segments")).not.toBeNull();
  });

  it("运行中批次：当前篇完成后暂停（不打断当前一篇）", () => {
    const batchId = queueBatch("mineru", ["p1", "p2", "p3"]);
    startBatch(batchId);
    beginBatchItem(batchId, "p1");
    render(<JobsPanel />);
    const card = screen.getByRole("article", { name: "MinerU 解析批次" });

    fireEvent.click(within(card).getByRole("button", { name: "当前篇完成后暂停" }));
    expect(actions.pauseBatchAfterCurrent).toHaveBeenCalledWith(batchId);
  });

  it("剩余时间估算展示样本篇数与区间", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T10:00:00.000Z"));
    try {
      const batchId = queueBatch("mineru", ["p1", "p2", "p3"]);
      startBatch(batchId);
      // 两篇各耗时 60s / 40s（样本 2），第三篇刚开始。
      beginBatchItem(batchId, "p1");
      vi.advanceTimersByTime(60_000);
      endBatchItem(batchId, "p1", "ok");
      beginBatchItem(batchId, "p2");
      vi.advanceTimersByTime(40_000);
      endBatchItem(batchId, "p2", "ok");
      beginBatchItem(batchId, "p3");
      render(<JobsPanel />);
      const card = screen.getByRole("article", { name: "MinerU 解析批次" });
      expect(within(card).getByText(/预计还需 .+（按 2 篇 · 区间 .+–.+）/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("暂停批次：提示剩余篇数并给「继续本批」", () => {
    const batchId = queueBatch("mineru", ["p1", "p2", "p3"]);
    startBatch(batchId);
    beginBatchItem(batchId, "p1");
    endBatchItem(batchId, "p1", "ok");
    finishBatch(batchId, "halted");
    render(<JobsPanel />);
    const card = screen.getByRole("article", { name: "MinerU 解析批次" });

    expect(within(card).getByText(/已暂停，剩余 2 篇未处理/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "继续本批" }));
    expect(actions.resumeHaltedBatch).toHaveBeenCalledWith(batchId);
  });

  it("AI 补全批次也有停止本批：确认文案带当前论文与剩余篇数", () => {
    const batchId = queueBatch("meta", ["q1", "q2", "q3"]);
    startBatch(batchId);
    beginBatchItem(batchId, "q1");
    render(<JobsPanel />);
    const card = screen.getByRole("article", { name: "AI 补全批次" });

    fireEvent.click(within(card).getByRole("button", { name: "停止本批…" }));
    expect(actions.stopMineruBatch).not.toHaveBeenCalled();
    // 确认文案：正在补全的一篇会取消，其余 2 篇不再提交。
    expect(within(card).getByText(/会取消，其余 2 篇排队论文不再提交/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "确认停止" }));
    expect(actions.stopMineruBatch).toHaveBeenCalledWith(batchId);
  });

  it("排队列表：标题取轻量书目，可移出队列，点标题跳到论文", async () => {
    vi.mocked(repo.paperBriefs).mockResolvedValue([
      { id: "p2", title: "Second", titleZh: "第二篇", domainId: "d-2", domainName: "指令对齐", domainCode: "AL-02" },
      { id: "p3", title: "Third", titleZh: null, domainId: "d-2", domainName: "指令对齐", domainCode: "AL-02" },
    ]);
    const batchId = queueBatch("mineru", ["p1", "p2", "p3"]);
    startBatch(batchId);
    beginBatchItem(batchId, "p1");
    render(<JobsPanel />);

    const queue = await screen.findByRole("region", { name: "排队中的论文" });
    await within(queue).findByText("第二篇");
    expect(within(queue).getByText("下一篇 · 待解析")).toBeInTheDocument();

    fireEvent.click(within(queue).getByRole("button", { name: "移出队列：Third" }));
    expect(actions.dequeueMineruPaper).toHaveBeenCalledWith(batchId, "p3");

    fireEvent.click(within(queue).getByText("第二篇"));
    await waitFor(() => expect(actions.selectPaper).toHaveBeenCalledWith("p2"));
    expect(actions.selectDomain).toHaveBeenCalledWith("d-2");
  });

  it("最近结束：失败原因可见，最近一次失败的解析可直接重新解析", () => {
    useField.setState({
      jobs: [
        job({
          id: "e",
          paperId: "p9",
          status: "error",
          error: "API Token 已过期，请在 mineru.net 重新生成",
          finishedAt: new Date().toISOString(),
        }),
        job({ id: "d", paperId: "p8", type: "prepareMeta", status: "done", finishedAt: new Date().toISOString() }),
      ],
    });
    render(<JobsPanel />);
    const history = screen.getByRole("region", { name: "最近结束的作业" });
    expect(within(history).getByText("API Token 已过期，请在 mineru.net 重新生成")).toBeInTheDocument();
    expect(within(history).getAllByRole("button", { name: "重新解析" })).toHaveLength(1);
    fireEvent.click(within(history).getByRole("button", { name: "重新解析" }));
    expect(actions.retryMineru).toHaveBeenCalledWith("p9");
  });

  it("最近结束：类型筛选、只看失败、标题搜索与清除已完成", () => {
    useField.setState({
      jobs: [
        job({
          id: "e1",
          paperId: "p9",
          status: "error",
          error: "Token 过期",
          finishedAt: new Date(Date.now() - 1_000).toISOString(),
        }),
        job({ id: "d1", paperId: "p8", type: "prepareMeta", status: "done", finishedAt: new Date(Date.now() - 2_000).toISOString() }),
        job({ id: "d2", paperId: "p7", status: "done", finishedAt: new Date(Date.now() - 3_000).toISOString() }),
      ],
    });
    render(<JobsPanel />);
    const history = screen.getByRole("region", { name: "最近结束的作业" });
    // 默认 3 条全列出。
    expect(within(history).getAllByRole("listitem")).toHaveLength(3);

    // 只看 AI：补全完成的一条。
    fireEvent.click(within(history).getByRole("button", { name: "AI" }));
    expect(within(history).getAllByRole("listitem")).toHaveLength(1);
    expect(within(history).getByText("补全论文信息")).toBeInTheDocument();

    // 只看失败：失败的一条带原因。
    fireEvent.click(within(history).getByRole("button", { name: "失败" }));
    expect(within(history).getAllByRole("listitem")).toHaveLength(1);
    expect(within(history).getByText("Token 过期")).toBeInTheDocument();

    // 标题搜索无命中给空态。
    fireEvent.change(within(history).getByRole("searchbox", { name: "搜索结束作业" }), {
      target: { value: "不存在的标题" },
    });
    expect(within(history).getByText("没有符合条件的结束作业。")).toBeInTheDocument();

    // 回到全部：清除已完成只留失败项。
    fireEvent.click(within(history).getByRole("button", { name: "全部" }));
    fireEvent.change(within(history).getByRole("searchbox", { name: "搜索结束作业" }), { target: { value: "" } });
    fireEvent.click(within(history).getByRole("button", { name: "清除已完成" }));
    expect(within(history).getAllByRole("listitem")).toHaveLength(1);
    expect(within(history).getByText("Token 过期")).toBeInTheDocument();
    // 已完成清掉后不再显示「清除已完成」入口。
    expect(within(history).queryByRole("button", { name: "清除已完成" })).toBeNull();
  });

  it("失败与取消的 AI 作业可就地重试；失败成批时给批量重试入口", () => {
    useField.setState({
      jobs: [
        job({ id: "m1", paperId: "p1", status: "error", error: "解析失败", finishedAt: new Date(Date.now() - 1_000).toISOString() }),
        job({ id: "m2", paperId: "p2", status: "error", error: "解析失败", finishedAt: new Date(Date.now() - 2_000).toISOString() }),
        job({ id: "a1", paperId: "p3", type: "prepareMeta", status: "error", error: "LLM HTTP 429", finishedAt: new Date(Date.now() - 3_000).toISOString() }),
        job({ id: "a2", paperId: "p4", type: "prepareMeta", status: "error", error: "LLM HTTP 429", finishedAt: new Date(Date.now() - 4_000).toISOString() }),
        job({ id: "a3", paperId: "p5", type: "draftNotes", status: "cancelled", error: "cancelled", finishedAt: new Date(Date.now() - 5_000).toISOString() }),
      ],
    });
    render(<JobsPanel />);
    const history = screen.getByRole("region", { name: "最近结束的作业" });

    // 单条：解析失败「重新解析」、补全失败「重新补全」、起草取消「重新起草」。
    expect(within(history).getAllByRole("button", { name: "重新解析" })).toHaveLength(2);
    expect(within(history).getAllByRole("button", { name: "重新补全" })).toHaveLength(2);
    fireEvent.click(within(history).getAllByRole("button", { name: "重新补全" })[0]);
    expect(actions.retryHistoryJob).toHaveBeenCalledWith("p3", "prepareMeta");
    fireEvent.click(within(history).getByRole("button", { name: "重新起草" }));
    expect(actions.retryHistoryJob).toHaveBeenCalledWith("p5", "draftNotes");

    // 成批：失败解析 / 失败补全分开一键重试。
    fireEvent.click(within(history).getByRole("button", { name: "重试失败解析（2 篇）" }));
    expect(actions.retryMineruPapers).toHaveBeenCalledWith(["p1", "p2"]);
    fireEvent.click(within(history).getByRole("button", { name: "重试失败补全（2 篇）" }));
    expect(actions.retryFailedMetaJobs).toHaveBeenCalledWith(["p3", "p4"]);
  });

  it("完成作业的结果直达：阅读全文 / 查看字段 / 查看笔记", async () => {
    useField.setState({
      jobs: [
        job({ id: "m", paperId: "p1", status: "done", finishedAt: new Date().toISOString() }),
        job({ id: "a", paperId: "p2", type: "prepareMeta", status: "done", finishedAt: new Date().toISOString() }),
        job({ id: "n", paperId: "p3", type: "draftNotes", status: "done", finishedAt: new Date().toISOString() }),
        job({ id: "l", paperId: "p4", type: "refreshLinks", status: "done", finishedAt: new Date().toISOString() }),
      ],
    });
    render(<JobsPanel />);
    const history = screen.getByRole("region", { name: "最近结束的作业" });

    fireEvent.click(within(history).getByRole("button", { name: "阅读全文" }));
    expect(actions.openPaperFulltext).toHaveBeenCalledWith("p1");

    fireEvent.click(within(history).getByRole("button", { name: "查看字段" }));
    expect(actions.openDialog).toHaveBeenCalledWith("edit-paper", "p2");

    fireEvent.click(within(history).getByRole("button", { name: "查看笔记" }));
    await waitFor(() => expect(actions.selectPaper).toHaveBeenCalledWith("p3"));

    // 刷新链接的完成不提供专门入口（结果在资料栏，标题本身可跳转）。
    expect(within(history).queryByRole("button", { name: "查看资料" })).toBeNull();
  });

  it("完成提醒偏好：默认开启汇总，切换口径与关闭都落本机", () => {
    render(<JobsPanel />);
    const bar = screen.getByRole("contentinfo", { name: "完成提醒偏好" });

    // 默认：开启 + 批次汇总 + 不开系统通知。
    const enabled = within(bar).getByRole("checkbox", { name: "完成时提醒我" }) as HTMLInputElement;
    expect(enabled.checked).toBe(true);
    const system = within(bar).getByRole("checkbox", { name: "失焦系统通知" }) as HTMLInputElement;
    expect(system.checked).toBe(false);

    // 切换口径 → localStorage 保存；关闭总开关后口径与系统通知都不再可用。
    fireEvent.change(within(bar).getByRole("combobox", { name: "完成提醒口径" }), { target: { value: "perItem" } });
    expect(localStorage.getItem("paper-field.job-notify")).toContain('"mode":"perItem"');

    fireEvent.click(enabled);
    expect(JSON.parse(localStorage.getItem("paper-field.job-notify")!)).toMatchObject({
      enabled: false,
      mode: "perItem",
    });
    expect((within(bar).getByRole("combobox", { name: "完成提醒口径" }) as HTMLSelectElement).disabled).toBe(true);
    expect(system.disabled).toBe(true);
  });

  it("失焦系统通知在当前环境不支持时给出提示并保持关闭", async () => {
    render(<JobsPanel />);
    const bar = screen.getByRole("contentinfo", { name: "完成提醒偏好" });
    fireEvent.click(within(bar).getByRole("checkbox", { name: "失焦系统通知" }));
    await waitFor(() =>
      expect(useField.getState().flash?.text).toContain("当前环境不支持系统通知"),
    );
    // 不支持的开关保持关闭，不写入偏好。
    expect(localStorage.getItem("paper-field.job-notify")).toBe(null);
    const system = within(bar).getByRole("checkbox", { name: "失焦系统通知" }) as HTMLInputElement;
    expect(system.checked).toBe(false);
  });

  it("本机批次记录：跨会话批次可回看、含中断口径说明，并可导出", () => {
    const done = journalBegin("mineru", ["a", "b"]);
    journalItem(done, "a", "ok");
    journalItem(done, "b", "fail");
    journalFinish(done, "done");
    journalBegin("meta", ["c"]); // 未收尾 → 应用退出中断

    render(<JobsPanel />);
    const section = screen.getByRole("region", { name: "本机批次记录" });
    expect(within(section).getByText(/2 篇 · 成功 1 · 失败 1/)).toBeInTheDocument();
    expect(within(section).getByText("已完成")).toBeInTheDocument();
    expect(within(section).getByText("应用退出中断")).toBeInTheDocument();
    expect(within(section).getByText(/远端任务可能仍在解析/)).toBeInTheDocument();

    // 导出走浏览器下载路径（jsdom 提供 createObjectURL）：给成功提示与文件名。
    fireEvent.click(within(section).getByRole("button", { name: "导出本机记录" }));
    expect(useField.getState().flash?.tone).toBe("ok");
    expect(useField.getState().flash?.text).toContain("批次记录已下载为 paper-field-jobs-");
  });

  it("没有批次记录时不渲染「本机批次记录」区", () => {
    render(<JobsPanel />);
    expect(screen.queryByRole("region", { name: "本机批次记录" })).toBeNull();
  });

  it("失败作业一键复制错误信息与作业 id", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    useField.setState({
      jobs: [
        job({
          id: "job-42",
          paperId: "p9",
          status: "error",
          error: "SSH 远程：curl: (28) Operation timed out",
          finishedAt: new Date().toISOString(),
        }),
      ],
    });
    render(<JobsPanel />);
    const history = screen.getByRole("region", { name: "最近结束的作业" });

    fireEvent.click(within(history).getByRole("button", { name: "复制错误信息" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("作业 ID：job-42");
    expect(copied).toContain("失败原因：SSH 远程：curl: (28) Operation timed out");
    expect(useField.getState().flash?.text).toContain("已复制失败原因与作业 ID");
  });

  it("查不到书目（旧版 repo / 查询失败）时退回短编号，不报错", async () => {
    vi.mocked(repo.paperBriefs).mockRejectedValue(new Error("boom"));
    const batchId = queueBatch("mineru", ["abcd-1234", "ef01-5678"]);
    startBatch(batchId);
    beginBatchItem(batchId, "abcd-1234");
    render(<JobsPanel />);
    expect(await screen.findByText("论文 EF01")).toBeInTheDocument();
    expect(getActivity().batches).toHaveLength(1);
  });
});

describe("排队总览与调度", () => {
  /** 10 篇排队（p1 处理中）：默认展示 6 篇，其余折叠并给领域分布。 */
  async function setupQueue() {
    const ids = Array.from({ length: 10 }, (_, i) => `p${i + 1}`);
    vi.mocked(repo.paperBriefs).mockResolvedValue(
      ids.slice(1).map((id, i) => ({
        id,
        title: `Title ${id}`,
        titleZh: `第${id}篇`,
        domainId: i < 7 ? "d-1" : "d-2",
        domainName: i < 7 ? "多模态" : "指令对齐",
        domainCode: "MM-01",
      })),
    );
    const batchId = queueBatch("mineru", ids);
    startBatch(batchId);
    beginBatchItem(batchId, "p1");
    render(<JobsPanel />);
    const queue = await screen.findByRole("region", { name: "排队中的论文" });
    return { batchId, queue };
  }

  it("默认 6 篇 + 「还有 N 篇」带领域分布；展开记住偏好", async () => {
    const { queue } = await setupQueue();
    // p1 处理中：队列里 9 篇，默认展示 6 篇。
    expect(within(queue).getAllByText(/· 待解析/)).toHaveLength(6);
    expect(within(queue).getByRole("button", { name: /还有 3 篇/ })).toBeInTheDocument();
    // 领域名来自异步的 paperBriefs。折叠的 3 篇按数量从多到少排（p9/p10 指令对齐、p8 多模态）。
    expect(await within(queue).findByText("指令对齐 2 · 多模态 1")).toBeInTheDocument();

    fireEvent.click(within(queue).getByRole("button", { name: /还有 3 篇/ }));
    expect(within(queue).getAllByText(/· 待解析/)).toHaveLength(9);
    expect(within(queue).getByRole("button", { name: "收起" })).toBeInTheDocument();
    // 展开偏好写入本机：重新挂载仍然全量展开。
    expect(localStorage.getItem("paper-field.jobs-queue-expanded")).toBe("1");
    fireEvent.click(within(queue).getByRole("button", { name: "收起" }));
    expect(localStorage.getItem("paper-field.jobs-queue-expanded")).toBe(null);
  });

  it("标题搜索与类型筛选：命中全部列出，无命中给空态", async () => {
    const { queue } = await setupQueue();
    fireEvent.change(within(queue).getByRole("searchbox", { name: "搜索排队论文标题" }), {
      target: { value: "p5" },
    });
    expect(within(queue).getAllByText(/· 待解析/)).toHaveLength(1);
    expect(within(queue).getByText("1 / 9 篇")).toBeInTheDocument();

    fireEvent.change(within(queue).getByRole("combobox", { name: "排队类型筛选" }), {
      target: { value: "meta" },
    });
    expect(within(queue).getByText("没有符合条件的排队论文。")).toBeInTheDocument();

    fireEvent.change(within(queue).getByRole("searchbox", { name: "搜索排队论文标题" }), {
      target: { value: "" },
    });
    expect(within(queue).getByText("没有符合条件的排队论文。")).toBeInTheDocument();
  });

  it("置顶 / 上移 / 下移换位与「清空其余」二次确认", async () => {
    const { batchId, queue } = await setupQueue();
    // 排队第一篇（p2）只能下移；第二篇（p3）可置顶 / 上移 / 下移。
    expect(await within(queue).findAllByRole("button", { name: /置顶到下一篇/ })).not.toHaveLength(0);
    fireEvent.click(await within(queue).findByRole("button", { name: "置顶到下一篇：第p3篇" }));
    expect(actions.reorderQueue).toHaveBeenCalledWith(batchId, "p3", "top");
    fireEvent.click(await within(queue).findByRole("button", { name: "下移一位：第p2篇" }));
    expect(actions.reorderQueue).toHaveBeenCalledWith(batchId, "p2", "down");
    fireEvent.click(await within(queue).findByRole("button", { name: "上移一位：第p3篇" }));
    expect(actions.reorderQueue).toHaveBeenCalledWith(batchId, "p3", "up");

    fireEvent.click(within(queue).getByRole("button", { name: "清空其余…" }));
    expect(actions.clearQueueRest).not.toHaveBeenCalled();
    fireEvent.click(within(queue).getByRole("button", { name: "确认清空" }));
    expect(actions.clearQueueRest).toHaveBeenCalledWith(batchId);
  });
});

describe("App 级入口", () => {
  it(`${"⌘J / Ctrl+J"} 开关作业面板，Esc 关闭`, async () => {
    useField.setState(useField.getInitialState(), true);
    render(<App />);
    await screen.findByRole("button", { name: /队列空闲/ });

    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "作业面板" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /队列空闲/ })).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "作业面板" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /队列空闲/ }));
    expect(await screen.findByRole("dialog", { name: "作业面板" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "作业面板" })).toBeNull());
  });

  it("钉住为右侧常驻栏：占一列布局，Esc 不收起，取消钉住后恢复", async () => {
    useField.setState(useField.getInitialState(), true);
    render(<App />);
    await screen.findByRole("button", { name: /队列空闲/ });

    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    const panel = await screen.findByRole("dialog", { name: "作业面板" });
    fireEvent.click(within(panel).getByRole("button", { name: "钉住为右侧常驻栏" }));

    expect(useField.getState().jobsPinned).toBe(true);
    expect(panel.className).toContain("is-pinned");
    expect(document.querySelector(".ef-shell")!.className).toContain("is-jobs-pinned");

    // 钉住的面板是布局一部分：Esc 不再当作浮层收起。
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useField.getState().jobsOpen).toBe(true);
    expect(screen.getByRole("dialog", { name: "作业面板" })).toBeInTheDocument();

    // 取消钉住：回到浮动面板语义。
    fireEvent.click(within(panel).getByRole("button", { name: "取消钉住（回到浮动面板）" }));
    expect(useField.getState().jobsPinned).toBe(false);
    expect(document.querySelector(".ef-shell")!.className).not.toContain("is-jobs-pinned");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "作业面板" })).toBeNull());
  });
});
