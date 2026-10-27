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
  },
}));

import App from "../App";
import {
  beginBatchItem,
  endBatchItem,
  getActivity,
  queueBatch,
  resetActivity,
  startBatch,
  trackJob,
} from "../lib/activity";
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
};

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
  useField.setState({ ...actions, jobsOpen: true });
  Object.values(actions).forEach((fn) => fn.mockClear());
  resetActivity();
  localStorage.removeItem("paper-field.jobs-queue-expanded");
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
    expect(within(card).getByText("多模态 · DeepSeek（deepseek-chat） · 失败时回退其余 1 个")).toBeInTheDocument();
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
    expect(within(card).getByRole("img", { name: /已处理 1 \/ 3 篇/ })).toBeInTheDocument();
    expect(card.querySelectorAll(".ef-segments li")).toHaveLength(3);
    expect(card.querySelector(".ef-segments li.is-current")).not.toBeNull();
    expect(within(card).getByText("排队 1")).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "停止本批…" }));
    expect(actions.stopMineruBatch).not.toHaveBeenCalled();
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
    // 折叠的 3 篇按领域计数（p8 多模态、p9/p10 指令对齐），按数量从多到少排。
    expect(within(queue).getByText("指令对齐 2 · 多模态 1")).toBeInTheDocument();

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
    expect(within(queue).getAllByRole("button", { name: /置顶到下一篇/ }).length).toBeGreaterThan(0);
    fireEvent.click(within(queue).getByRole("button", { name: "置顶到下一篇：第p3篇" }));
    expect(actions.reorderQueue).toHaveBeenCalledWith(batchId, "p3", "top");
    fireEvent.click(within(queue).getByRole("button", { name: "下移一位：第p2篇" }));
    expect(actions.reorderQueue).toHaveBeenCalledWith(batchId, "p2", "down");
    fireEvent.click(within(queue).getByRole("button", { name: "上移一位：第p3篇" }));
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
});
