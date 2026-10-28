// 关联/替换本机 PDF 的 store 链路：真实 repo（sql.js 内存库，浏览器态 adopt 原样返回路径）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestEngine, type TestEngineHandle } from "./test/helpers";
import type { SqlEngine } from "./lib/engine";

const holder = vi.hoisted(() => ({ engine: null as SqlEngine | null }));
vi.mock("./lib/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/engine")>()),
  getEngine: () => Promise.resolve(holder.engine!),
}));

import { repo } from "./lib/repo";
import { useField } from "./store";
import { dismissAll } from "./toasts";

let handle: TestEngineHandle;
let domainId: string;

beforeEach(async () => {
  handle = await makeTestEngine();
  holder.engine = handle.engine;
  domainId = (await repo.createDomain({ name: "多模态", code: "MM-01" })).id;
  useField.setState(useField.getInitialState(), true);
});

afterEach(() => {
  dismissAll("manual");
  handle.close();
});

describe("attachPaperPdf · 为已有论文关联/替换本机 PDF", () => {
  it("先建档后拿到的 PDF 可以补挂：路径与原始路径写入，未解析标 pending", async () => {
    const paper = await repo.createPaper({ domainId, title: "只有标题的论文" });
    useField.setState({ mode: "field", selectedDomainId: domainId, selectedPaperId: paper.id });

    await useField.getState().attachPaperPdf(paper.id, "/papers/late.pdf");

    const fresh = await repo.getPaper(paper.id);
    expect(fresh?.pdfPath).toBe("/papers/late.pdf");
    expect(fresh?.pdfOriginalPath).toBe("/papers/late.pdf");
    expect(fresh?.mineruStatus).toBe("pending");
    // 测试环境未配置解析源：诚实提示「尚未启用解析源」
    expect(useField.getState().flash?.tone).toBe("ok");
    expect(useField.getState().flash?.text).toContain("已关联 PDF（late.pdf）");
    expect(useField.getState().flash?.text).toContain("尚未启用解析源");
  });

  it("替换已有 PDF：新文件覆盖旧路径（旧文件名不再保留）", async () => {
    const paper = await repo.createPaper({ domainId, title: "T", pdfPath: "/library/old.pdf", pdfOriginalPath: "/papers/old.pdf" });
    await useField.getState().attachPaperPdf(paper.id, "/papers/new.pdf");
    const fresh = await repo.getPaper(paper.id);
    expect(fresh?.pdfPath).toBe("/papers/new.pdf");
    expect(fresh?.pdfOriginalPath).toBe("/papers/new.pdf");
  });

  it("重复关联同一文件给友好提示，不重复复制", async () => {
    const paper = await repo.createPaper({ domainId, title: "T", pdfPath: "/library/a.pdf", pdfOriginalPath: "/papers/a.pdf" });
    await useField.getState().attachPaperPdf(paper.id, "/papers/a.pdf");
    expect(useField.getState().flash?.text).toBe("这篇论文已经关联这个文件。");
    const fresh = await repo.getPaper(paper.id);
    expect(fresh?.pdfPath).toBe("/library/a.pdf");
  });

  it("已在库中（别的论文关联过）的文件报错且数据未改动", async () => {
    await repo.createPaper({ domainId, title: "A", pdfPath: "/library/a.pdf", pdfOriginalPath: "/papers/a.pdf" });
    const other = await repo.createPaper({ domainId, title: "B" });
    await expect(useField.getState().attachPaperPdf(other.id, "/papers/a.pdf")).rejects.toThrow("已在库中");
    expect(useField.getState().flash?.tone).toBe("error");
    const fresh = await repo.getPaper(other.id);
    expect(fresh?.pdfPath).toBeNull();
  });
});
