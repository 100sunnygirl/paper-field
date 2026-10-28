import { beforeEach, describe, expect, it } from "vitest";
import { clearReReads, listReReads, recordReRead } from "./reReads";

beforeEach(() => {
  localStorage.removeItem("paper-field.re-reads");
});

describe("reReads · 复读记录（本机）", () => {
  it("记录一次复读（可带备注）、按时间升序读取、可清除", () => {
    expect(listReReads("p1")).toEqual([]);
    const at1 = new Date("2026-01-01T09:00:00");
    const at2 = new Date("2026-02-01T09:00:00");
    recordReRead("p1", undefined, at1);
    recordReRead("p1", "  第二遍关注消融实验 ", at2);
    expect(listReReads("p1")).toEqual([
      { at: at1.toISOString() },
      { at: at2.toISOString(), note: "第二遍关注消融实验" },
    ]);

    clearReReads("p1");
    expect(listReReads("p1")).toEqual([]);
  });

  it("坏数据整包容错：非对象 / 非数组记录 / 非法时间戳都被丢弃", () => {
    localStorage.setItem("paper-field.re-reads", JSON.stringify({ p1: "oops", p2: [{ at: "bad" }, { note: 3 }, null, { at: "2026-01-01T00:00:00.000Z" }] }));
    expect(listReReads("p1")).toEqual([]);
    expect(listReReads("p2")).toEqual([{ at: "2026-01-01T00:00:00.000Z" }]);
    localStorage.setItem("paper-field.re-reads", "not-json");
    expect(listReReads("p2")).toEqual([]);
  });

  it("每篇上限 50 条，超出裁最旧的", () => {
    for (let i = 0; i < 53; i += 1) {
      recordReRead("p9", undefined, new Date(2026, 0, 1 + i));
    }
    const records = listReReads("p9");
    expect(records).toHaveLength(50);
    expect(records[0]!.at).toBe(new Date(2026, 0, 4).toISOString());
  });
});
