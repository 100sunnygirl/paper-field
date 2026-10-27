import { beforeEach, describe, expect, it } from "vitest";
import { clearReadingSpot, loadReadingSpots, saveReadingSpot, type ReadingSpot } from "./readingSpot";

function spot(overrides: Partial<ReadingSpot> = {}): ReadingSpot {
  return { top: 120, section: "note-summary", fulltextOpen: false, at: 1_700_000_000_000, ...overrides };
}

beforeEach(() => {
  localStorage.removeItem("paper-field.reading-spot");
});

describe("readingSpot · 每篇论文的阅读现场", () => {
  it("保存后可读回：按论文 id 隔离", () => {
    saveReadingSpot("p1", spot({ top: 320, section: "ft-sec-3" }));
    saveReadingSpot("p2", spot({ top: 40, section: "abstract", fulltextOpen: true }));
    const spots = loadReadingSpots();
    expect(spots.p1).toEqual({ top: 320, section: "ft-sec-3", fulltextOpen: false, at: 1_700_000_000_000 });
    expect(spots.p2?.fulltextOpen).toBe(true);
  });

  it("坏数据（缺字段 / 类型不对）整条丢弃，不影响其他条目", () => {
    localStorage.setItem(
      "paper-field.reading-spot",
      JSON.stringify({
        good: spot(),
        noTop: { section: "abstract", fulltextOpen: false, at: 1 },
        badSection: { top: 1, section: 42, fulltextOpen: false, at: 1 },
        negative: { top: -5, section: "abstract", fulltextOpen: true, at: 1 },
      }),
    );
    const spots = loadReadingSpots();
    expect(Object.keys(spots)).toEqual(["good"]);
  });

  it("JSON 损坏或空值回落空表，不抛错", () => {
    localStorage.setItem("paper-field.reading-spot", "{not json");
    expect(loadReadingSpots()).toEqual({});
    localStorage.removeItem("paper-field.reading-spot");
    expect(loadReadingSpots()).toEqual({});
  });

  it("超过 50 篇时裁掉最久未读的现场", () => {
    for (let i = 0; i < 55; i += 1) {
      saveReadingSpot(`p${i}`, spot({ at: 1_000 + i }));
    }
    const spots = loadReadingSpots();
    expect(Object.keys(spots)).toHaveLength(50);
    // 最早写入的 5 篇被裁掉
    expect(spots.p0).toBeUndefined();
    expect(spots.p4).toBeUndefined();
    expect(spots.p5).toBeDefined();
    expect(spots.p54).toBeDefined();
  });

  it("clearReadingSpot 只清指定论文", () => {
    saveReadingSpot("p1", spot());
    saveReadingSpot("p2", spot());
    clearReadingSpot("p1");
    const spots = loadReadingSpots();
    expect(spots.p1).toBeUndefined();
    expect(spots.p2).toBeDefined();
    // 不存在的清除是空操作
    clearReadingSpot("p-missing");
    expect(loadReadingSpots().p2).toBeDefined();
  });

  it("saveReadingSpot 拒绝写坏数据", () => {
    saveReadingSpot("p1", { top: Number.NaN, section: "abstract", fulltextOpen: false, at: 1 });
    saveReadingSpot("", spot());
    expect(loadReadingSpots()).toEqual({});
  });
});
