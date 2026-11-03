// 空领域快速建档的 store 链路：真实 repo（sql.js 内存库）。
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

import { repo } from "./lib/repo";
import { useField } from "./store";
import { dismissAll } from "./toasts";

let handle: TestEngineHandle;
let domainId: string;

beforeEach(async () => {
  handle = await makeTestEngine();
  holder.engine = handle.engine;
  domainId = (await repo.createDomain({ name: "新领域", code: "N-01" })).id;
  useField.setState(useField.getInitialState(), true);
  useField.setState({ mode: "field", selectedDomainId: domainId });
});

afterEach(() => {
  dismissAll("manual");
  handle.close();
});

describe("createQuickEntry · 粘贴建档", () => {
  it("arXiv 链接：标识符入库、不占用标题（留给文献库替换），并选中新建档", async () => {
    await useField.getState().createQuickEntry("https://arxiv.org/abs/2401.12345");
    const paper = await repo.getPaper(useField.getState().selectedPaperId!);
    expect(paper?.arxivId).toBe("2401.12345");
    // 标识符建档不写标题：无来源标记的「未命名论文」可被文献库替换
    expect(paper?.title).toBe("未命名论文");
    expect(paper?.fieldSources?.title).toBeUndefined();
    expect(useField.getState().flash?.text).toContain("已按 arXiv:2401.12345 建档");
  });

  it("DOI：规整后入库", async () => {
    await useField.getState().createQuickEntry("https://doi.org/10.1038/s41586-024-12345-6");
    const paper = await repo.getPaper(useField.getState().selectedPaperId!);
    expect(paper?.doi).toBe("10.1038/s41586-024-12345-6");
    expect(useField.getState().flash?.text).toContain("已按 DOI");
  });

  it("普通文字按标题建档（手动拥有的标题）", async () => {
    await useField.getState().createQuickEntry("Attention Is All You Need");
    const paper = await repo.getPaper(useField.getState().selectedPaperId!);
    expect(paper?.title).toBe("Attention Is All You Need");
    expect(paper?.fieldSources?.title).toBe("user");
    expect(useField.getState().flash?.text).toContain("已创建「Attention Is All You Need」");
  });

  it("空输入报错且不建档；过长非标识符内容拒绝当标题", async () => {
    await expect(useField.getState().createQuickEntry("   ")).rejects.toThrow("先粘贴");
    const before = (await repo.listPapers(domainId)).length;
    await expect(useField.getState().createQuickEntry("很".repeat(201))).rejects.toThrow("200 字以内");
    expect((await repo.listPapers(domainId)).length).toBe(before);
  });
});
