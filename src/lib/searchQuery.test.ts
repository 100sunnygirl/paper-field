import { describe, expect, it } from "vitest";
import { hasStructuredQuery, parseSearchQuery } from "./searchQuery";

describe("searchQuery · tag:/domain:/year: 检索语法", () => {
  it("解析三种前缀并可组合，剩余文本保留", () => {
    const q = parseSearchQuery("tag:rlhf domain:指令对齐 year:2024 transformer");
    expect(q.tags).toEqual(["rlhf"]);
    expect(q.domains).toEqual(["指令对齐"]);
    expect(q.years).toEqual([2024]);
    expect(q.text).toBe("transformer");
  });

  it("全角冒号等价；d: 是 domain: 的短写", () => {
    const q = parseSearchQuery("tag：clip d:MM-01");
    expect(q.tags).toEqual(["clip"]);
    expect(q.domains).toEqual(["MM-01"]);
  });

  it("year: 非四位数字回落普通文本；空串安全", () => {
    const q = parseSearchQuery("year:20x4 标题");
    expect(q.years).toEqual([]);
    expect(q.text).toContain("year:20x4");
    expect(parseSearchQuery("")).toEqual({ tags: [], domains: [], years: [], text: "" });
  });

  it("hasStructuredQuery 判定", () => {
    expect(hasStructuredQuery("tag:rlhf")).toBe(true);
    expect(hasStructuredQuery("year:2024")).toBe(true);
    expect(hasStructuredQuery("普通词")).toBe(false);
    expect(hasStructuredQuery("")).toBe(false);
  });
});
