import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlEngine } from "./lib/engine";

const holder = vi.hoisted(() => ({ engine: null as SqlEngine | null }));

vi.mock("./lib/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/engine")>();
  return { ...actual, getEngine: () => Promise.resolve(holder.engine!) };
});

vi.mock("./lib/lookup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/lookup")>();
  return { ...actual, lookupPaper: vi.fn() };
});

vi.mock("./lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/settings")>();
  return {
    ...actual,
    completeChat: vi.fn(),
    cancelChat: vi.fn(async () => undefined),
  };
});

import { makeTestEngine, type TestEngineHandle } from "./test/helpers";
import { lookupPaper } from "./lib/lookup";
import { repo } from "./lib/repo";
import { completeChat } from "./lib/settings";
import { useField } from "./store";

const usable = {
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

let handle: TestEngineHandle;

beforeEach(async () => {
  handle = await makeTestEngine();
  holder.engine = handle.engine;
  await handle.engine.execute("DELETE FROM app_meta");
  vi.mocked(lookupPaper).mockReset();
  vi.mocked(completeChat).mockReset();
  useField.setState({ ...useField.getInitialState(), settings: usable, ready: true }, true);
});

describe("runPrepareMeta 覆盖顺序与在途锁", () => {
  it("overwrite 时文献库先写，模型空书目留下文献值而不是用户旧标题", async () => {
    const domain = await repo.createDomain({ name: "多模态", code: "MM-01" });
    const paper = await repo.createPaper({ domainId: domain.id, title: "用户旧标题", userOwned: true });
    await repo.updatePaper(paper.id, { venue: "用户旧期刊" }, true);

    vi.mocked(lookupPaper).mockResolvedValue({
      meta: {
        title: "Attention Is All You Need",
        titleZh: null,
        abstract: "biblio abstract",
        year: 2017,
        venue: "NeurIPS",
        doi: null,
        arxivId: null,
        authors: [{ name: "Ashish Vaswani" }],
        labs: [],
        codeOpenSource: "unknown",
        codeURL: null,
        projectPage: null,
        pdfURL: null,
        tags: [],
      },
      notices: [],
      openalexRemainingUsd: null,
      openalexLimitUsd: null,
    });
    vi.mocked(completeChat).mockResolvedValue(
      JSON.stringify({
        title: null,
        titleZh: null,
        abstract: null,
        year: null,
        venue: null,
        doi: null,
        arxivId: null,
        authors: [],
        labs: [],
        codeOpenSource: "unknown",
        codeURL: null,
        projectPage: null,
        pdfURL: null,
        tags: [],
      }),
    );

    await useField.getState().runPrepareMeta(paper.id, true);

    const detail = (await repo.getPaper(paper.id))!;
    expect(detail.title).toBe("Attention Is All You Need");
    expect(detail.venue).toBe("NeurIPS");
    expect(detail.title).not.toBe("用户旧标题");
    expect(detail.venue).not.toBe("用户旧期刊");
  });

  it("补全在途时第二次调用不再查询文献库", async () => {
    const domain = await repo.createDomain({ name: "多模态", code: "MM-02" });
    const paper = await repo.createPaper({ domainId: domain.id, title: "在途" });
    let release: (value: Awaited<ReturnType<typeof lookupPaper>>) => void = () => undefined;
    vi.mocked(completeChat).mockResolvedValue("{}");
    vi.mocked(lookupPaper).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const first = useField.getState().runPrepareMeta(paper.id, false);
    await vi.waitFor(() => expect(lookupPaper).toHaveBeenCalledTimes(1));
    const second = useField.getState().runPrepareMeta(paper.id, false);
    await second;
    expect(lookupPaper).toHaveBeenCalledTimes(1);

    release({ meta: null, notices: [], openalexRemainingUsd: null, openalexLimitUsd: null });
    await first;
  });
});
