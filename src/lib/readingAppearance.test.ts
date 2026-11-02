import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE,
  clearPaperAppearance,
  getAppearance,
  hasPaperAppearance,
  loadAppearanceStore,
  setDefaultAppearance,
  setPaperAppearance,
  type AppearanceStore,
} from "./readingAppearance";

beforeEach(() => {
  localStorage.removeItem("paper-field.read-appearance");
});

describe("readingAppearance · 阅读外观档位", () => {
  it("默认字号标准、行宽标准；未覆盖的论文用本机默认", () => {
    const store = loadAppearanceStore();
    expect(store.default).toEqual(DEFAULT_APPEARANCE);
    expect(getAppearance(store, "p1")).toEqual({ fontStep: 2, width: "standard" });
    expect(hasPaperAppearance(store, "p1")).toBe(false);
  });

  it("调本篇只写这篇的覆盖，不影响其他论文", () => {
    let store: AppearanceStore = loadAppearanceStore();
    store = setPaperAppearance(store, "p1", { fontStep: 4, width: "wide" });
    expect(getAppearance(store, "p1")).toEqual({ fontStep: 4, width: "wide" });
    expect(getAppearance(store, "p2")).toEqual(DEFAULT_APPEARANCE);
    expect(hasPaperAppearance(store, "p1")).toBe(true);
    // 写穿 localStorage
    const persisted = JSON.parse(localStorage.getItem("paper-field.read-appearance")!) as AppearanceStore;
    expect(persisted.papers.p1).toEqual({ fontStep: 4, width: "wide" });
  });

  it("「恢复默认」清掉本篇覆盖，「应用到所有论文」提升本机默认", () => {
    let store: AppearanceStore = loadAppearanceStore();
    store = setPaperAppearance(store, "p1", { fontStep: 0, width: "narrow" });
    store = setDefaultAppearance(store, { fontStep: 3, width: "standard" });
    expect(getAppearance(store, "p1")).toEqual({ fontStep: 0, width: "narrow" });
    expect(getAppearance(store, "p2")).toEqual({ fontStep: 3, width: "standard" });
    store = clearPaperAppearance(store, "p1");
    expect(getAppearance(store, "p1")).toEqual({ fontStep: 3, width: "standard" });
    expect(hasPaperAppearance(store, "p1")).toBe(false);
  });

  it("坏数据（越界档位 / 未知行宽 / 损坏 JSON）回落默认", () => {
    localStorage.setItem(
      "paper-field.read-appearance",
      JSON.stringify({
        default: { fontStep: 9, width: "huge" },
        papers: { p1: { fontStep: 1, width: "wide" }, p2: "junk" },
      }),
    );
    const store = loadAppearanceStore();
    expect(store.default).toEqual(DEFAULT_APPEARANCE);
    expect(store.papers.p1).toEqual({ fontStep: 1, width: "wide" });
    expect(store.papers.p2).toBeUndefined();

    localStorage.setItem("paper-field.read-appearance", "{broken");
    expect(loadAppearanceStore().default).toEqual(DEFAULT_APPEARANCE);
  });

  it("setPaperAppearance 拒绝写坏数据（保持原 store）", () => {
    const store = loadAppearanceStore();
    const next = setPaperAppearance(store, "p1", { fontStep: -1, width: "wide" });
    expect(hasPaperAppearance(next, "p1")).toBe(false);
  });
});
