import { describe, expect, it } from "vitest";
import type { PaperListItem } from "./types";
import { readingStatsFrom } from "./readingStats";

function read(id: string, iso: string, domainName = "多模态"): PaperListItem {
  return {
    id,
    domainId: "d-1",
    title: id,
    titleZh: null,
    abstract: "",
    year: null,
    venue: null,
    doi: null,
    arxivId: null,
    pdfUrl: null,
    pdfPath: null,
    codeUrl: null,
    codeOpenSource: "unknown",
    projectPage: null,
    readingStatus: "read",
    readAt: iso,
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
    mineruCredFingerprint: null,
    tags: [],
    labs: [],
    createdAt: iso,
    updatedAt: iso,
    firstAuthor: null,
    authorCount: 0,
    domainName,
    domainCode: "MM-01",
  };
}

// 2026-10-28 是周三；本周一是 10-26，本月 1 日是 10-01，今年起点 01-01。
const NOW = new Date(2026, 9, 28, 12, 0, 0);

describe("readingStatsFrom · 归档阅读成果统计", () => {
  it("本周 / 本月 / 今年按周一、月初、年初起算，逐月分布正确", () => {
    const items = [
      read("a", "2026-10-28T09:00:00.000", "多模态"), // 今天（本地 17:00 → 10-28）
      read("b", "2026-10-26T01:00:00.000", "多模态"), // 周一
      read("c", "2026-10-01T01:00:00.000", "指令对齐"), // 本月第 1 天
      read("d", "2025-12-31T23:00:00.000", "指令对齐"), // 去年：不计今年
    ];
    const stats = readingStatsFrom(items, NOW);
    expect(stats.week).toBe(2);
    expect(stats.month).toBe(3);
    expect(stats.year).toBe(3);
    expect(stats.months[9]).toBe(3); // 十月 3 篇
    expect(stats.topDomain).toBe("多模态"); // 今年 2 vs 1
  });

  it("连续阅读：今天没读不断串（从昨天起算），出现空档即止", () => {
    const items = [
      read("a", "2026-10-27T01:00:00.000"), // 昨天
      read("b", "2026-10-26T01:00:00.000"), // 前天
      read("c", "2026-10-23T01:00:00.000"), // 大前天之前一天 → 空档
    ];
    expect(readingStatsFrom(items, NOW).streak).toBe(2);

    const todayToo = [read("t", "2026-10-28T01:00:00.000"), ...items];
    expect(readingStatsFrom(todayToo, NOW).streak).toBe(3);

    expect(readingStatsFrom([], NOW).streak).toBe(0);
  });

  it("没有 readAt 或非法时间戳的已读论文不参与统计", () => {
    const broken = { ...read("x", "2026-10-28T01:00:00.000"), readAt: null };
    const invalid = { ...read("y", "not-a-date") };
    const stats = readingStatsFrom([broken, invalid], NOW);
    expect(stats.week).toBe(0);
    expect(stats.streak).toBe(0);
  });

  it("今年没有已读时 topDomain 为 null，月份全为 0", () => {
    const stats = readingStatsFrom([read("old", "2025-06-01T01:00:00.000")], NOW);
    expect(stats.year).toBe(0);
    expect(stats.topDomain).toBeNull();
    expect(stats.months.every((n) => n === 0)).toBe(true);
  });
});
