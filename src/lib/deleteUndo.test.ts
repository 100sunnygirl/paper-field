import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestEngine, type TestEngineHandle } from "../test/helpers";
import type { SqlEngine } from "./engine";

const holder = vi.hoisted(() => ({ engine: null as SqlEngine | null }));
vi.mock("./engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./engine")>()),
  getEngine: () => Promise.resolve(holder.engine!),
}));

import {
  DELETE_UNDO_TTL_MS,
  captureDomainDelete,
  capturePaperDelete,
  clearDeleteUndo,
  restoreDeleteUndo,
  saveDeleteUndo,
  takeDeleteUndo,
} from "./deleteUndo";
import { repo } from "./repo";

let handle: TestEngineHandle;

beforeEach(async () => {
  if (handle) handle.close();
  handle = await makeTestEngine();
  holder.engine = handle.engine;
  clearDeleteUndo();
});

async function seedLibrary() {
  const domain = await repo.createDomain({ name: "多模态", code: "MM-01" });
  const paper = await repo.createPaper({ domainId: domain.id, title: "Visual Instruction Tuning" });
  await repo.replaceAuthors(paper.id, [
    { name: "Haotian Liu", affiliation: "UW-Madison", lab: "Liu Lab", isCorresponding: true },
  ]);
  await repo.updateNote(paper.id, "summary", "五块笔记之一", "manual", true);
  return { domain, paper };
}

describe("deleteUndo · 论文快照与恢复", () => {
  it("快照捕获论文/笔记/作者关联/解析表，恢复后 SELECT * 逐行一致", async () => {
    const { domain, paper } = await seedLibrary();
    const before = await holder.engine!.select<Record<string, unknown>>(
      "SELECT * FROM papers WHERE id = ?",
      [paper.id],
    );
    const entry = await capturePaperDelete([paper.id], "Visual Instruction Tuning");
    expect(entry.paperIds).toEqual([paper.id]);
    expect(entry.domainId).toBe(domain.id);
    expect(entry.data.papers.rows.length).toBe(1);
    expect(entry.data.notes.rows.length).toBeGreaterThanOrEqual(1);
    expect(entry.data.authors.rows.length).toBe(1);
    expect(entry.data.paperAuthors.rows.length).toBe(1);

    await holder.engine!.execute("DELETE FROM papers WHERE id = ?", [paper.id]);
    expect(await repo.getPaper(paper.id)).toBeNull();

    await restoreDeleteUndo(entry);
    const after = await holder.engine!.select<Record<string, unknown>>(
      "SELECT * FROM papers WHERE id = ?",
      [paper.id],
    );
    expect(after).toEqual(before);
    const restored = await repo.getPaper(paper.id);
    expect(restored?.notes.summary.content).toBe("五块笔记之一");
    expect(restored?.authors[0]?.name).toBe("Haotian Liu");
  });

  it("恢复走 INSERT OR REPLACE：同名作者（仍在库）被原行覆盖，不产生重复", async () => {
    const { domain, paper } = await seedLibrary();
    // 同领域另一篇论文引用同一位作者：删 A 时作者行不消失，恢复 A 也不该造出第二行。
    const other = await repo.createPaper({ domainId: domain.id, title: "Another Paper" });
    await repo.replaceAuthors(other.id, [
      { name: "Haotian Liu", affiliation: "UW-Madison", lab: "Liu Lab", isCorresponding: false },
    ]);
    const entry = await capturePaperDelete([paper.id], "Visual Instruction Tuning");
    await holder.engine!.execute("DELETE FROM papers WHERE id = ?", [paper.id]);
    await restoreDeleteUndo(entry);
    const authors = await holder.engine!.select<{ n: number }>(
      "SELECT count(*) AS n FROM authors WHERE name = 'Haotian Liu'",
    );
    expect(Number(authors[0]!.n)).toBe(1);
  });
});

describe("deleteUndo · 领域快照与恢复", () => {
  it("整域删除可恢复：领域、论文、笔记、关联一次回插", async () => {
    const { domain, paper } = await seedLibrary();
    const entry = await captureDomainDelete(domain.id, "多模态");
    expect(entry.kind).toBe("domain");
    expect(entry.data.domain?.rows.length).toBe(1);
    expect(entry.data.papers.rows.length).toBe(1);

    await holder.engine!.execute("DELETE FROM domains WHERE id = ?", [domain.id]);
    expect(await repo.getDomain(domain.id)).toBeNull();
    expect(await repo.getPaper(paper.id)).toBeNull();

    await restoreDeleteUndo(entry);
    expect((await repo.getDomain(domain.id))?.name).toBe("多模态");
    expect((await repo.getPaper(paper.id))?.notes.summary.content).toBe("五块笔记之一");
  });
});

describe("deleteUndo · 限时缓冲", () => {
  it("save 后 take 取出同一条并清空缓冲；再 take 为 null", async () => {
    const { paper } = await seedLibrary();
    const entry = await capturePaperDelete([paper.id], "X");
    saveDeleteUndo(entry);
    expect(takeDeleteUndo()).toMatchObject({ label: "X" });
    expect(takeDeleteUndo()).toBeNull();
  });

  it("超过兜底寿命的条目视为过期（撤销窗口已过）", async () => {
    const { paper } = await seedLibrary();
    const entry = await capturePaperDelete([paper.id], "X");
    const stale = { ...entry, at: Date.now() - DELETE_UNDO_TTL_MS - 1 };
    saveDeleteUndo(stale);
    expect(takeDeleteUndo()).toBeNull();
  });

  it("localStorage 写不进时退回内存副本（会话内仍可撤销）", async () => {
    const { paper } = await seedLibrary();
    const entry = await capturePaperDelete([paper.id], "X");
    const setItem = localStorage.setItem;
    localStorage.setItem = vi.fn(() => {
      throw new Error("quota");
    });
    try {
      saveDeleteUndo(entry);
    } finally {
      localStorage.setItem = setItem;
    }
    expect(takeDeleteUndo()).toMatchObject({ label: "X" });
  });
});
