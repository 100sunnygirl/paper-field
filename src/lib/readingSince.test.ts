import { beforeEach, describe, expect, it } from "vitest";
import { daysInto, noteReadingStatus, readingSinceFor } from "./readingSince";

const NOW = new Date("2026-10-27T10:00:00.000Z").getTime();
const DAY = 86_400_000;

beforeEach(() => {
  localStorage.removeItem("paper-field.reading-since");
});

describe("readingSince · 在读起点的本机记录", () => {
  it("改为在读记起点；已读保留；未读清除后再在读重新起算", () => {
    noteReadingStatus("p1", "reading", NOW);
    expect(readingSinceFor("p1")).toBe(new Date(NOW).toISOString());

    // 已读保留同一起点（read→reading→read 往返不重置）
    noteReadingStatus("p1", "read", NOW + DAY);
    expect(readingSinceFor("p1")).toBe(new Date(NOW).toISOString());
    noteReadingStatus("p1", "reading", NOW + 2 * DAY);
    expect(readingSinceFor("p1")).toBe(new Date(NOW).toISOString());

    // 未读清除；再次在读重新起算
    noteReadingStatus("p1", "unread", NOW + 3 * DAY);
    expect(readingSinceFor("p1")).toBeNull();
    noteReadingStatus("p1", "reading", NOW + 3 * DAY);
    expect(readingSinceFor("p1")).toBe(new Date(NOW + 3 * DAY).toISOString());
  });

  it("没有记录时 readingSinceFor 返回 null；未读的清除是空操作", () => {
    expect(readingSinceFor("p-missing")).toBeNull();
    noteReadingStatus("p2", "unread", NOW);
    expect(readingSinceFor("p2")).toBeNull();
  });

  it("超过 200 条时裁掉最早的起点", () => {
    for (let i = 0; i < 205; i += 1) {
      noteReadingStatus(`p${i}`, "reading", NOW + i * 1000);
    }
    expect(readingSinceFor("p0")).toBeNull();
    expect(readingSinceFor("p4")).toBeNull();
    expect(readingSinceFor("p5")).not.toBeNull();
    expect(readingSinceFor("p204")).not.toBeNull();
    const persisted = JSON.parse(localStorage.getItem("paper-field.reading-since")!) as Record<string, string>;
    expect(Object.keys(persisted)).toHaveLength(200);
  });

  it("localStorage 损坏 / 坏条目被忽略", () => {
    localStorage.setItem("paper-field.reading-since", JSON.stringify({ good: "2026-10-01T00:00:00.000Z", bad: 42, junk: "not-a-date" }));
    expect(readingSinceFor("good")).toBe("2026-10-01T00:00:00.000Z");
    expect(readingSinceFor("bad")).toBeNull();
    localStorage.setItem("paper-field.reading-since", "{broken");
    expect(readingSinceFor("good")).toBeNull();
  });

  it("daysInto：当天是第 1 天，隔 N 天是第 N+1 天；坏时间返回 null", () => {
    expect(daysInto(new Date(NOW).toISOString(), NOW)).toBe(1);
    expect(daysInto(new Date(NOW - 1000).toISOString(), NOW)).toBe(1);
    expect(daysInto(new Date(NOW - 2 * DAY).toISOString(), NOW)).toBe(3);
    expect(daysInto(new Date(NOW - 30 * DAY).toISOString(), NOW)).toBe(31);
    expect(daysInto(null, NOW)).toBeNull();
    expect(daysInto("not-a-date", NOW)).toBeNull();
  });
});
