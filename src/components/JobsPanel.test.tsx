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
  landOnPaper: vi.fn(async () => undefined),
  selectPaper: vi.fn(async () => undefined),
  dequeueMineruPaper: vi.fn(),
  stopMineruBatch: vi.fn(async () => undefined),
};

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
  useField.setState({ ...actions, jobsOpen: true });
  Object.values(actions).forEach((fn) => fn.mockClear());
  resetActivity();
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
    await waitFor(() => expect(actions.landOnPaper).toHaveBeenCalledWith("p2", "d-2"));
    expect(actions.selectPaper).not.toHaveBeenCalled();
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
