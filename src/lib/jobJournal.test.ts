import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exportJobJournal,
  hasInterruptedBatches,
  journalBegin,
  journalFinish,
  journalItem,
  listJobBatches,
  resetJobJournal,
} from "./jobJournal";

beforeEach(() => {
  resetJobJournal();
});

afterEach(() => {
  resetJobJournal();
});

describe("本机批次记录", () => {
  it("begin → 逐篇落账 → finish：读回清单、结果计数与状态", () => {
    const id = journalBegin("mineru", ["a", "b", "c"]);
    journalItem(id, "a", "ok");
    journalItem(id, "b", "fail");
    journalItem(id, "c", "cancelled");
    journalFinish(id, "done");

    const entries = listJobBatches();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "mineru",
      state: "done",
      paperIds: ["a", "b", "c"],
      results: { a: "ok", b: "fail", c: "cancelled" },
      finishedAt: expect.any(Number),
    });
  });

  it("没有写终态的 running 记录显示为「应用退出中断」（与启动清扫口径一致）", () => {
    const id = journalBegin("meta", ["a"]);
    journalItem(id, "a", "ok");
    // 不调 journalFinish，模拟应用退出。

    const entries = listJobBatches();
    expect(entries[0].state).toBe("interrupted");
    expect(entries[0].finishedAt).toBeNull();
    expect(hasInterruptedBatches()).toBe(true);
  });

  it("按提交时间新 → 旧排列；超过 7 天的不列出", () => {
    const old = journalBegin("mineru", ["old"]);
    journalFinish(old, "done");
    // 把第一条挪到 8 天前。
    const raw = JSON.parse(localStorage.getItem("paper-field.job-journal")!) as Array<{ queuedAt: number }>;
    raw[0].queuedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem("paper-field.job-journal", JSON.stringify(raw));

    const first = journalBegin("mineru", ["new"]);
    journalFinish(first, "done");
    const second = journalBegin("meta", ["newer"]);
    journalFinish(second, "done");

    const entries = listJobBatches(7);
    expect(entries.map((entry) => entry.paperIds[0])).toEqual(["newer", "new"]);
  });

  it("写入超过上限时只保留最近 60 条（控制 localStorage 体积）", () => {
    for (let i = 0; i < 62; i += 1) {
      journalFinish(journalBegin("mineru", [`p${i}`]), "done");
    }
    const entries = listJobBatches(3650);
    expect(entries).toHaveLength(60);
    expect(entries[0].paperIds[0]).toBe("p61"); // 最新在前
  });

  it("损坏的存储回空列表，不抛错", () => {
    localStorage.setItem("paper-field.job-journal", "{oops");
    expect(listJobBatches()).toEqual([]);
    // 之后的写入恢复正常。
    journalFinish(journalBegin("mineru", ["a"]), "done");
    expect(listJobBatches()).toHaveLength(1);
  });

  it("导出文本：含口径说明、状态与逐篇计数", () => {
    const id = journalBegin("mineru", ["a", "b"]);
    journalItem(id, "a", "ok");
    journalItem(id, "b", "fail");
    journalFinish(id, "halted");

    const text = exportJobJournal(listJobBatches());
    expect(text).toContain("paper-field 本机批次记录");
    expect(text).toContain("不随备份走");
    expect(text).toContain("MinerU 解析 · 已暂停");
    expect(text).toContain("成功 1 · 失败 1 · 取消 0 · 跳过 0");
  });
});
