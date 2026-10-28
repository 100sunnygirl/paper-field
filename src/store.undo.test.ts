// 删除/移动的限时撤销（先软删除的应用层快照）与移动去向选择：真实 repo（sql.js 内存库）。
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

import { clearDeleteUndo } from "./lib/deleteUndo";
import { repo } from "./lib/repo";
import { useField } from "./store";
import { dismissAll } from "./toasts";

let handle: TestEngineHandle;
let domainA: string;
let domainB: string;

async function makePaper(title: string, domainId: string): Promise<string> {
  const paper = await repo.createPaper({ domainId, title });
  return paper.id;
}

beforeEach(async () => {
  handle = await makeTestEngine();
  holder.engine = handle.engine;
  domainA = (await repo.createDomain({ name: "领域甲", code: "A-01" })).id;
  domainB = (await repo.createDomain({ name: "领域乙", code: "B-01" })).id;
  useField.setState(useField.getInitialState(), true);
  clearDeleteUndo();
});

afterEach(() => {
  dismissAll("manual");
  handle.close();
});

describe("删除论文的限时撤销", () => {
  it("删除后提示带「撤销删除」：点击后论文、笔记、解析与草稿原样恢复并选中", async () => {
    const id = await makePaper("Visual Instruction Tuning", domainA);
    await repo.updateNote(id, "summary", "写好的总结", "manual", true);
    useField.setState({ mode: "field", selectedDomainId: domainA, selectedPaperId: id });
    useField.getState().setNoteDraft(id, "highlights", "未保存的亮点草稿");

    await useField.getState().deletePaper(id);

    expect(await repo.getPaper(id)).toBeNull();
    const flash = useField.getState().flash;
    expect(flash?.text).toBe("论文已删除。");
    expect(flash?.action?.label).toBe("撤销删除");

    await useField.getState().undoDelete();

    const restored = await repo.getPaper(id);
    expect(restored?.title).toBe("Visual Instruction Tuning");
    expect(restored?.notes.summary.content).toBe("写好的总结");
    expect(useField.getState().selectedPaperId).toBe(id);
    expect(useField.getState().selectedDomainId).toBe(domainA);
    // 未保存草稿原样放回
    expect(useField.getState().drafts[id]?.highlights).toBe("未保存的亮点草稿");
    expect(useField.getState().flash?.text).toContain("已撤销删除");
  });

  it("批量删除同样可整批撤销", async () => {
    const a = await makePaper("甲篇", domainA);
    const b = await makePaper("乙篇", domainA);
    useField.setState({ mode: "field", selectedDomainId: domainA, batchMode: true, checkedPaperIds: [a, b] });

    await useField.getState().deleteCheckedPapers();
    expect(useField.getState().flash?.text).toContain("已删除 2 篇论文");
    expect(useField.getState().flash?.action?.label).toBe("撤销删除");

    await useField.getState().undoDelete();
    expect((await repo.getPaper(a))?.title).toBe("甲篇");
    expect((await repo.getPaper(b))?.title).toBe("乙篇");
  });

  it("撤销窗口已过（缓冲被清）时给出提示，不再恢复", async () => {
    const id = await makePaper("过期论文", domainA);
    useField.setState({ mode: "field", selectedDomainId: domainA, selectedPaperId: id });
    await useField.getState().deletePaper(id);
    clearDeleteUndo();

    await useField.getState().undoDelete();
    expect(await repo.getPaper(id)).toBeNull();
    expect(useField.getState().flash?.text).toContain("撤销窗口已过");
  });

  it("删除领域可整域撤销：领域、论文与笔记一并恢复并回到该领域", async () => {
    const id = await makePaper("域内论文", domainB);
    await repo.updateNote(id, "summary", "域内笔记", "manual", true);
    useField.setState({ mode: "field", selectedDomainId: domainB, selectedPaperId: id });

    await useField.getState().deleteDomain();
    expect(await repo.getDomain(domainB)).toBeNull();
    expect(useField.getState().flash?.text).toContain("已删除领域「领域乙」与 1 篇论文");

    await useField.getState().undoDelete();
    expect((await repo.getDomain(domainB))?.name).toBe("领域乙");
    const restored = await repo.getPaper(id);
    expect(restored?.notes.summary.content).toBe("域内笔记");
    expect(useField.getState().selectedDomainId).toBe(domainB);
  });
});

describe("移动论文的撤销移回与去向选择", () => {
  it("默认跟随到目标领域；提示带「撤销移回」，点击后论文回到原领域", async () => {
    const id = await makePaper("要移动的论文", domainA);
    useField.setState({ mode: "field", selectedDomainId: domainA, selectedPaperId: id });

    await useField.getState().movePaper(domainB, id);
    expect((await repo.getPaper(id))?.domainId).toBe(domainB);
    expect(useField.getState().selectedDomainId).toBe(domainB);
    expect(useField.getState().flash?.text).toBe("论文已移动到「领域乙」。");
    expect(useField.getState().flash?.action?.label).toBe("撤销移回");

    useField.getState().flash!.action!.run();
    await vi.waitFor(async () => {
      expect((await repo.getPaper(id))?.domainId).toBe(domainA);
      expect(useField.getState().flash?.text).toContain("已移回「领域甲」");
    });
    expect(useField.getState().selectedDomainId).toBe(domainA);
  });

  it("选择「留在原领域」：论文移走后用户仍看原领域列表，撤销同样成立", async () => {
    const id = await makePaper("留在原领域", domainA);
    useField.setState({ mode: "field", selectedDomainId: domainA, selectedPaperId: id });

    await useField.getState().movePaper(domainB, id, { follow: false });
    expect((await repo.getPaper(id))?.domainId).toBe(domainB);
    expect(useField.getState().selectedDomainId).toBe(domainA);
    expect(useField.getState().flash?.text).toContain("你仍留在「领域甲」");

    useField.getState().flash!.action!.run();
    // 等「已移回」提示出现：movePaperBack 的刷新与选中都已落地（不留悬挂的异步链）。
    await vi.waitFor(async () => {
      expect((await repo.getPaper(id))?.domainId).toBe(domainA);
      expect(useField.getState().flash?.text).toContain("已移回「领域甲」");
    });
    expect(useField.getState().selectedDomainId).toBe(domainA);
    expect(useField.getState().selectedPaperId).toBe(id);
  });

  it("移回目标与原领域相同（重复移动）不给撤销按钮", async () => {
    const id = await makePaper("原地不动", domainA);
    useField.setState({ mode: "field", selectedDomainId: domainA, selectedPaperId: id });
    await useField.getState().movePaper(domainA, id);
    expect(useField.getState().flash?.action).toBeUndefined();
  });
});
