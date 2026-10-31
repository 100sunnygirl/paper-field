import { beforeEach, describe, expect, it } from "vitest";
import {
  clearRecentDomains,
  loadRecentDomains,
  orderDomainsByRecent,
  recordDomainVisit,
} from "./domainRecent";

beforeEach(() => {
  localStorage.clear();
});

describe("domainRecent · 最近领域记忆", () => {
  it("记录访问并置顶、去重，最近在前", () => {
    recordDomainVisit("d-1");
    recordDomainVisit("d-2");
    recordDomainVisit("d-1");
    expect(loadRecentDomains()).toEqual(["d-1", "d-2"]);
  });

  it("超过上限时裁掉最旧的", () => {
    for (let i = 1; i <= 11; i += 1) recordDomainVisit(`d-${i}`);
    const ids = loadRecentDomains();
    expect(ids).toHaveLength(9);
    expect(ids[0]).toBe("d-11");
    expect(ids).not.toContain("d-1");
    expect(ids).not.toContain("d-2");
  });

  it("坏数据整表丢弃，返回空表", () => {
    localStorage.setItem("paper-field.domain-recent", "{not json");
    expect(loadRecentDomains()).toEqual([]);
    localStorage.setItem("paper-field.domain-recent", JSON.stringify({ 1: "x" }));
    expect(loadRecentDomains()).toEqual([]);
  });

  it("clearRecentDomains 清空记录", () => {
    recordDomainVisit("d-1");
    clearRecentDomains();
    expect(loadRecentDomains()).toEqual([]);
  });

  it("orderDomainsByRecent：最近访问在前，其余保持原顺序，不改原数组", () => {
    const domains = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ];
    const ordered = orderDomainsByRecent(domains, ["c", "a"]);
    expect(ordered.map((d) => d.id)).toEqual(["c", "a", "b"]);
    expect(domains.map((d) => d.id)).toEqual(["a", "b", "c"]);
  });
});
