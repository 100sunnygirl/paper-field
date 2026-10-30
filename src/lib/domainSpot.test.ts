import { beforeEach, describe, expect, it } from "vitest";
import { clearDomainSpot, domainSpotOf, loadDomainSpots, saveDomainSpot } from "./domainSpot";

beforeEach(() => {
  localStorage.clear();
});

describe("domainSpot · 每领域列表现场", () => {
  it("保存与读取：搜索词 / 选中论文 / 滚动位置", () => {
    saveDomainSpot("d-1", { search: "clip", paperId: "p-2", listTop: 120, at: 1 });
    expect(domainSpotOf("d-1")).toEqual({ search: "clip", paperId: "p-2", listTop: 120, at: 1 });
    expect(domainSpotOf("d-2")).toBeUndefined();
  });

  it("坏数据条目被丢弃，不影响其他领域", () => {
    localStorage.setItem(
      "paper-field.domain-spot",
      JSON.stringify({ "d-1": { search: 1 }, "d-2": { search: "ok", paperId: null, listTop: 0, at: 2 } }),
    );
    const spots = loadDomainSpots();
    expect(Object.keys(spots)).toEqual(["d-2"]);
  });

  it("超过 12 个领域时裁掉最久未用的", () => {
    for (let i = 1; i <= 14; i += 1) {
      saveDomainSpot(`d-${i}`, { search: `q${i}`, paperId: null, listTop: i, at: i });
    }
    const spots = loadDomainSpots();
    expect(Object.keys(spots)).toHaveLength(12);
    expect(spots["d-1"]).toBeUndefined();
    expect(spots["d-2"]).toBeUndefined();
    expect(spots["d-14"].search).toBe("q14");
  });

  it("clearDomainSpot 清掉单个领域", () => {
    saveDomainSpot("d-1", { search: "x", paperId: null, listTop: 0, at: 1 });
    clearDomainSpot("d-1");
    expect(domainSpotOf("d-1")).toBeUndefined();
  });
});
