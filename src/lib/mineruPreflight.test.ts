import { describe, expect, it } from "vitest";
import { DEFAULT_MINERU, type MineruSettingsV2 } from "./mineru";
import { mineruPreflight, parsePageRange } from "./mineruPreflight";

function settingsWith(patch: Partial<MineruSettingsV2>): MineruSettingsV2 {
  return { ...DEFAULT_MINERU, ...patch } as MineruSettingsV2;
}

describe("parsePageRange", () => {
  it("all 与空串按全部页（页数未知），写法有效", () => {
    expect(parsePageRange("all")).toEqual({ pages: null, valid: true });
    expect(parsePageRange("ALL")).toEqual({ pages: null, valid: true });
    expect(parsePageRange("  ")).toEqual({ pages: null, valid: true });
  });

  it("区间与单页混合求和；容忍空格", () => {
    expect(parsePageRange("1-3,5").pages).toBe(4);
    expect(parsePageRange("1 - 20").pages).toBe(20);
    expect(parsePageRange("7").pages).toBe(1);
    expect(parsePageRange("1-3, 8-10,12").pages).toBe(7);
  });

  it("非法写法 valid=false（页数不给猜测值）", () => {
    expect(parsePageRange("abc").valid).toBe(false);
    expect(parsePageRange("5-1").valid).toBe(false);
    expect(parsePageRange("1-3,,5").valid).toBe(false);
    expect(parsePageRange("第1-5页").valid).toBe(false);
  });
});

describe("mineruPreflight", () => {
  it("官方 API 未启用：不报限额，也不给额度提示（本地 / SSH 无此约束）", () => {
    const view = mineruPreflight({ files: 5, settings: settingsWith({ pageRange: "1-300" }) });
    expect(view.apiInChain).toBe(false);
    expect(view.warnings).toEqual([]);
    expect(view.notes).toEqual([]);
  });

  it("官方 API 启用 + 页码范围超 200 页：标红并给选页 / 换源建议", () => {
    const settings = settingsWith({ pageRange: "1-250", api: { ...DEFAULT_MINERU.api, hasToken: true } });
    const view = mineruPreflight({ files: 1, settings });
    expect(view.apiInChain).toBe(true);
    expect(view.pageRange.pages).toBe(250);
    expect(view.warnings.join("\n")).toContain("250 页");
    expect(view.warnings.join("\n")).toContain("200 页上限");
    expect(view.warnings.join("\n")).toContain("缩小页码范围");
  });

  it("本批预计页数 = 文件数 × 每篇页数，超每日 1000 页额度给出警示", () => {
    const settings = settingsWith({ pageRange: "1-60", api: { ...DEFAULT_MINERU.api, hasToken: true } });
    const view = mineruPreflight({ files: 20, settings });
    expect(view.estPages).toBe(1200);
    expect(view.warnings.join("\n")).toContain("1200 页");
    expect(view.warnings.join("\n")).toContain("每日 1000 页额度");
  });

  it("页码范围 all：预计页数未知，说明按实际页数核验且额度不可查", () => {
    const settings = settingsWith({ api: { ...DEFAULT_MINERU.api, hasToken: true } });
    const view = mineruPreflight({ files: 3, settings });
    expect(view.estPages).toBeNull();
    expect(view.warnings).toEqual([]);
    expect(view.notes.join("\n")).toContain("单文件 ≤200MB / ≤200 页");
    expect(view.notes.join("\n")).toContain("实际页数在提交时由桌面端核验");
    expect(view.notes.join("\n")).toContain("暂无查询接口");
  });

  it("写法无法解析：无论哪个源都提示写法问题", () => {
    const view = mineruPreflight({ files: 2, settings: settingsWith({ pageRange: "1..9" }) });
    expect(view.warnings.join("\n")).toContain("无法识别");
  });

  it("超过单批 50 个文件：给口径说明（逐篇提交不受单批限制，额度按总量计）", () => {
    const settings = settingsWith({ pageRange: "1-5", api: { ...DEFAULT_MINERU.api, hasToken: true } });
    const view = mineruPreflight({ files: 60, settings });
    expect(view.warnings).toEqual([]);
    expect(view.notes.join("\n")).toContain("60 个文件超过官方 API 单次提交 50 个的上限");
  });
});
