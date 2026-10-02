import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MineruParsePoll, MineruSettingsV2, MineruSubmitResult } from "./mineru";
import {
  cancelMineruPaper,
  clearMineruCancel,
  runMineruBatch,
} from "./mineruRun";
import type { PaperDetail } from "./types";

vi.mock("./mineru", () => ({
  mineruSubmit: vi.fn(),
  mineruParseStatuses: vi.fn(),
  mineruMarkdown: vi.fn(),
}));

vi.mock("./repo", () => ({
  repo: {
    getPaper: vi.fn(),
    listJobs: vi.fn(async () => []),
    updateJob: vi.fn(async () => undefined),
    createJob: vi.fn(async () => ({ id: "job-1", status: "queued" })),
    setMineruState: vi.fn(async () => undefined),
    saveParsedMarkdown: vi.fn(async () => undefined),
    listPendingMineru: vi.fn(async () => []),
    listReadyForMeta: vi.fn(async () => []),
  },
}));

import { mineruMarkdown, mineruParseStatuses, mineruSubmit } from "./mineru";
import { repo } from "./repo";

function paperState(overrides: Partial<PaperDetail> = {}): PaperDetail {
  return {
    id: "p-1",
    domainId: "d-1",
    title: "T",
    titleZh: null,
    abstract: "",
    year: null,
    venue: null,
    doi: null,
    arxivId: null,
    pdfUrl: null,
    pdfPath: "/papers/a.pdf",
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
    ...overrides,
  };
}

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

function makeHost(paper: PaperDetail, overrides: Partial<Parameters<typeof makeHostBase>[0]> = {}) {
  return makeHostBase({ paper, ...overrides });
}

function makeHostBase(options: {
  paper: PaperDetail;
  hasKey?: boolean;
  configured?: boolean;
  prepare?: (paperId: string, overwrite: boolean, quiet: boolean) => Promise<void>;
}) {
  const paper = options.paper;
  const host = {
    mineru: () => ({ ...settings, configured: options.configured ?? true }),
    hasKey: () => options.hasKey ?? true,
    refresh: vi.fn(async () => undefined),
    flash: vi.fn(),
    prepare: vi.fn(
      options.prepare ??
        (async () => {
          // 模拟 runPrepareMeta 的落库效果：llm_prepared_at 写入。
          paper.llmPreparedAt = new Date().toISOString();
        }),
    ),
  };
  vi.mocked(repo.getPaper).mockImplementation(async () => paper);
  return host;
}

beforeEach(() => {
  vi.mocked(mineruSubmit).mockReset();
  vi.mocked(mineruParseStatuses).mockReset();
  vi.mocked(mineruMarkdown).mockReset();
  vi.mocked(repo.setMineruState).mockReset();
  vi.mocked(repo.saveParsedMarkdown).mockReset();
  vi.mocked(repo.createJob).mockClear();
  vi.mocked(repo.updateJob).mockClear();
  clearMineruCancel("p-1");
});

afterEach(() => {
  vi.useRealTimers();
});

function submitResult(overrides: Partial<MineruSubmitResult> = {}): MineruSubmitResult {
  return {
    provider: "local",
    remotePath: "/remote/a.pdf",
    shortId: "doc-1",
    parseIds: ["7"],
    status: "running",
    tier: "standard",
    ...overrides,
  };
}

function poll(status: string, overrides: Partial<MineruParsePoll> = {}): MineruParsePoll {
  return { id: "7", status, error: null, progress: null, ...overrides };
}

describe("autoPrepare（防覆盖语义）", () => {
  it("解析完成后调用 host.prepare(paperId, false, true)：overwrite=false 使 applyPreparedMeta 用户编辑锁生效", async () => {
    const paper = paperState({ mineruStatus: "done", parsedMarkdown: "# 已解析全文" });
    const host = makeHost(paper);

    await runMineruBatch(host, ["p-1"], false);

    expect(host.prepare).toHaveBeenCalledTimes(1);
    expect(host.prepare).toHaveBeenCalledWith("p-1", false, true);
    // quiet=true：不闪「AI 作业完成」提示，只保留解析完成提示。
    expect(host.flash).toHaveBeenCalledWith("ok", "MinerU 解析完成 1 篇。阅读状态未改动。");
  });

  it("llmPreparedAt 已设的论文不再重复补全", async () => {
    const paper = paperState({ mineruStatus: "done", parsedMarkdown: "# md", llmPreparedAt: "2024-01-01T00:00:00.000Z" });
    const host = makeHost(paper);
    await runMineruBatch(host, ["p-1"], false);
    expect(host.prepare).not.toHaveBeenCalled();
  });

  it("没有解析文本时不调用 prepare", async () => {
    const paper = paperState({ mineruStatus: "done", parsedMarkdown: "   " });
    const host = makeHost(paper);
    await runMineruBatch(host, ["p-1"], false);
    expect(host.prepare).not.toHaveBeenCalled();
  });

  it("未配置 LLM key 时提示补全缺失而不是静默成功", async () => {
    const paper = paperState({ mineruStatus: "done", parsedMarkdown: "# md" });
    const host = makeHost(paper, { hasKey: false });
    await runMineruBatch(host, ["p-1"], false);
    expect(host.prepare).not.toHaveBeenCalled();
    expect(host.flash).toHaveBeenCalledWith("warn", "解析完成。尚未配置 AI，书目仍使用文件名，可稍后补全。");
  });
});

describe("processOne 提交与轮询", () => {
  it("官方 API（parseIds=[]）必须先轮询 mineru_parse_statuses 等到 done 再取 markdown（I4b）", async () => {
    const paper = paperState();
    const host = makeHost(paper);
    vi.mocked(mineruSubmit).mockResolvedValue(
      submitResult({ provider: "api", remotePath: "", parseIds: [], shortId: "batch-1", tier: "pipeline", status: "running" }),
    );
    const statuses = vi.mocked(mineruParseStatuses).mockResolvedValue([
      poll("done", { id: "p-1", progress: "10/10" }),
    ]);
    vi.mocked(mineruMarkdown).mockResolvedValue("# api markdown");

    await runMineruBatch(host, ["p-1"], false);

    // 直接取 markdown 的短路分支（!parseIds.length && provider!=='api'）不得触发。
    expect(statuses).toHaveBeenCalledWith("api", "batch-1", []);
    // 轮询路径的 tier 取当前设置（同步 done 路径才用 SubmitResult.tier）。
    expect(mineruMarkdown).toHaveBeenCalledWith("api", "batch-1", "standard", "all");
    expect(repo.saveParsedMarkdown).toHaveBeenCalledWith("p-1", "# api markdown");
    const lastState = vi.mocked(repo.setMineruState).mock.lastCall?.[1];
    expect(lastState).toMatchObject({ status: "done" });
    // 提交成功即记录实际来源，重启后仍可同源轮询。
    expect(
      vi.mocked(repo.setMineruState).mock.calls.some(([, patch]) => patch?.provider === "api"),
    ).toBe(true);
  });

  it("doclib 同步完成（status=done）直接取 markdown，不进入轮询", async () => {
    const paper = paperState();
    const host = makeHost(paper);
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ status: "done" }));
    vi.mocked(mineruMarkdown).mockResolvedValue("# fast markdown");

    await runMineruBatch(host, ["p-1"], false);

    expect(mineruParseStatuses).not.toHaveBeenCalled();
    expect(mineruMarkdown).toHaveBeenCalledWith("local", "doc-1", "standard", "all");
    expect(repo.saveParsedMarkdown).toHaveBeenCalledWith("p-1", "# fast markdown");
  });

  it("本地/SSH 源无 parseIds 时允许直接取 markdown（doclib 短路）", async () => {
    const paper = paperState();
    const host = makeHost(paper);
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ parseIds: [] }));
    vi.mocked(mineruMarkdown).mockResolvedValue("# direct");

    await runMineruBatch(host, ["p-1"], false);

    expect(mineruParseStatuses).not.toHaveBeenCalled();
    expect(mineruMarkdown).toHaveBeenCalledWith("local", "doc-1", "standard", "all");
  });

  it("等待中的解析会先轮询再在 done 后取回（含 pending→done 一次推进）", async () => {
    const paper = paperState();
    const host = makeHost(paper);
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ status: "running" }));
    const statuses = vi
      .mocked(mineruParseStatuses)
      .mockResolvedValueOnce([poll("pending")])
      .mockResolvedValueOnce([poll("done")]);
    vi.mocked(mineruMarkdown).mockResolvedValue("# after-wait");

    vi.useFakeTimers();
    const batch = runMineruBatch(host, ["p-1"], false);
    // 第一次轮询返回 pending → sleep(4000) → 第二次 done。
    await vi.advanceTimersByTimeAsync(4_100);
    await batch;

    expect(statuses).toHaveBeenCalledTimes(2);
    expect(mineruMarkdown).toHaveBeenCalledWith("local", "doc-1", "standard", "all");
  });

  it("轮询报 failed 时作业与论文状态置 error", async () => {
    const paper = paperState();
    const host = makeHost(paper);
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ status: "running" }));
    vi.mocked(mineruParseStatuses).mockResolvedValue([poll("failed", { error: "页数超限" })]);

    await runMineruBatch(host, ["p-1"], false);

    expect(host.flash).toHaveBeenCalledWith("error", "MinerU 解析失败 1 篇，可在资料栏重试。");
    const lastState = vi.mocked(repo.setMineruState).mock.lastCall?.[1];
    expect(lastState).toMatchObject({ status: "error", error: "页数超限" });
    expect(repo.updateJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ status: "error", error: "页数超限" }),
    );
  });

  it("取消标记让批次以 cancelled 收场（建档前短路，不写任何状态）", async () => {
    const paper = paperState();
    const host = makeHost(paper);
    cancelMineruPaper("p-1");

    await runMineruBatch(host, ["p-1"], false);

    expect(mineruSubmit).not.toHaveBeenCalled();
    expect(repo.createJob).not.toHaveBeenCalled();
    expect(repo.setMineruState).not.toHaveBeenCalled();
    expect(host.flash).not.toHaveBeenCalled();
  });
});

describe("恢复仅同源（I4d）", () => {
  it("submitted + 已记录 provider：不重新提交，用同源轮询", async () => {
    const paper = paperState({
      mineruStatus: "submitted",
      mineruDocRef: "doc-resume",
      mineruParseIds: ["9"],
      mineruProvider: "ssh",
    });
    const host = makeHost(paper);
    vi.mocked(mineruParseStatuses).mockResolvedValue([poll("done", { id: "9" })]);
    vi.mocked(mineruMarkdown).mockResolvedValue("# resumed");

    await runMineruBatch(host, ["p-1"], false);

    expect(mineruSubmit).not.toHaveBeenCalled();
    expect(mineruParseStatuses).toHaveBeenCalledWith("ssh", "doc-resume", ["9"]);
    expect(mineruMarkdown).toHaveBeenCalledWith("ssh", "doc-resume", "standard", "all");
    expect(repo.saveParsedMarkdown).toHaveBeenCalledWith("p-1", "# resumed");
  });

  it("源级错误置 mineru_status=error，不自动换源重提", async () => {
    const paper = paperState({
      mineruStatus: "parsing",
      mineruDocRef: "doc-resume",
      mineruParseIds: ["9"],
      mineruProvider: "ssh",
    });
    const host = makeHost(paper);
    vi.mocked(mineruParseStatuses).mockRejectedValue(new Error("SSH 连接中断"));

    vi.useFakeTimers();
    const batch = runMineruBatch(host, ["p-1"], false);
    // pollStatuses 三次重试，每次间隔 2s。
    await vi.advanceTimersByTimeAsync(6_100);
    await batch;

    expect(mineruSubmit).not.toHaveBeenCalled();
    const lastState = vi.mocked(repo.setMineruState).mock.lastCall?.[1];
    expect(lastState).toMatchObject({ status: "error" });
    expect(lastState?.error).toContain("解析源不可用");
    expect(lastState?.error).toContain("SSH 连接中断");
    expect(lastState?.error).toContain("可点击重新解析换源重提");
  });

  it("旧数据（submitted 但无 provider）只能重新提交，由后端重选源", async () => {
    const paper = paperState({
      mineruStatus: "submitted",
      mineruDocRef: "doc-old",
      mineruParseIds: ["9"],
      mineruProvider: null,
    });
    const host = makeHost(paper);
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ provider: "api", parseIds: [], shortId: "batch-new", status: "running", tier: "pipeline" }));
    vi.mocked(mineruParseStatuses).mockResolvedValue([poll("done", { id: "p-1" })]);
    vi.mocked(mineruMarkdown).mockResolvedValue("# resubmitted");

    await runMineruBatch(host, ["p-1"], false);

    // provider 省略 = 后端按 order 自动 fallback 重选源。
    expect(mineruSubmit).toHaveBeenCalledWith("p-1", "/papers/a.pdf", false);
    expect(mineruParseStatuses).toHaveBeenCalledWith("api", "batch-new", []);
  });

  it("force=true 时即使可恢复也重新提交（retryMineru 跨源入口）", async () => {
    const paper = paperState({
      mineruStatus: "parsing",
      mineruDocRef: "doc-old",
      mineruParseIds: ["9"],
      mineruProvider: "ssh",
    });
    const host = makeHost(paper);
    vi.mocked(mineruSubmit).mockResolvedValue(submitResult({ provider: "api", parseIds: [], shortId: "batch-2", status: "running", tier: "pipeline" }));
    vi.mocked(mineruParseStatuses).mockResolvedValue([poll("done", { id: "p-1" })]);
    vi.mocked(mineruMarkdown).mockResolvedValue("# forced");

    await runMineruBatch(host, ["p-1"], true);

    expect(mineruSubmit).toHaveBeenCalledTimes(1);
    expect(mineruParseStatuses).toHaveBeenCalledWith("api", "batch-2", []);
  });
});

describe("runMineruBatch 守卫", () => {
  it("order 中无启用源（configured=false）时静默返回，不创建作业", async () => {
    const paper = paperState();
    const host = makeHost(paper, { configured: false });
    await runMineruBatch(host, ["p-1"], false);
    expect(repo.createJob).not.toHaveBeenCalled();
    expect(mineruSubmit).not.toHaveBeenCalled();
    expect(host.flash).not.toHaveBeenCalled();
  });

  it("没有 pdfPath 的论文跳过且不计失败", async () => {
    const paper = paperState({ pdfPath: null });
    const host = makeHost(paper);
    await runMineruBatch(host, ["p-1"], false);
    expect(repo.createJob).not.toHaveBeenCalled();
    expect(host.flash).not.toHaveBeenCalled();
  });
});

describe("runMineruBatch · 连续失败熔断", () => {
  function paperMap(ids: string[]): Record<string, PaperDetail> {
    const papers: Record<string, PaperDetail> = {};
    for (const id of ids) papers[id] = paperState({ id });
    return papers;
  }

  it("连续 3 篇提交失败后暂停剩余批次并给出指引", async () => {
    const ids = ["p1", "p2", "p3", "p4", "p5"];
    const papers = paperMap(ids);
    const host = makeHostBase({ paper: papers.p1 });
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => papers[id] ?? null);
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
  });

  it("失败被成功打断则不熔断，仍走普通失败汇总", async () => {
    const ids = ["p1", "p2", "p3"];
    const papers = paperMap(ids);
    const host = makeHostBase({ paper: papers.p1 });
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => papers[id] ?? null);
    vi.mocked(mineruSubmit)
      .mockRejectedValueOnce(new Error("busy"))
      // p2 提交即完成（status=done 直接取全文）
      .mockResolvedValueOnce(submitResult({ status: "done" }))
      .mockRejectedValueOnce(new Error("busy"));
    vi.mocked(mineruMarkdown).mockResolvedValue("# md");

    await runMineruBatch(host, ids, false);

    expect(mineruSubmit).toHaveBeenCalledTimes(3);
    const [tone, text] = host.flash.mock.calls.at(-1)!;
    expect(tone).toBe("error");
    expect(text).toContain("解析失败 2 篇");
    expect(text).not.toContain("已暂停");
  });
});
