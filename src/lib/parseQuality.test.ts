import { describe, expect, it } from "vitest";
import { checkParseQuality } from "./parseQuality";

const opts = { pageRange: "all", enableFormula: true, enableTable: true };

function doc(paragraphs: number, headings = 3, tables = 0, formulas = 0): string {
  const parts: string[] = ["# 标题"];
  for (let i = 0; i < headings - 1; i += 1) {
    parts.push(`## 第 ${i + 1} 节`);
    for (let p = 0; p < paragraphs; p += 1) parts.push(`这是第 ${i + 1} 节的第 ${p + 1} 段正文，足够长的一段内容。`);
  }
  const tail: string[] = [];
  if (tables) tail.push("| a | b |", "|---|---|", "| 1 | 2 |");
  if (formulas) tail.push("其中 $x^2$ 是公式。");
  // 尾部内容并入最后一段之后（不新起标题），避免「相邻标题无正文」的误报。
  return tail.length ? `${parts.join("\n\n")}\n\n${tail.join("\n")}` : parts.join("\n\n");
}

describe("checkParseQuality", () => {
  it("空全文给 empty 警告", () => {
    expect(checkParseQuality("  \n", opts)).toEqual([
      { kind: "empty", message: expect.stringContaining("解析结果为空") },
    ]);
  });

  it("相邻标题之间没有正文：报疑似空页", () => {
    const md = "# 标题\n\n## 一节\n\n有正文。\n\n## 下一节\n\n## 再下一节\n\n又有正文。";
    const warnings = checkParseQuality(md, opts);
    expect(warnings.some((w) => w.kind === "blank-page")).toBe(true);
  });

  it("正文充分但没有表格（表格开关开启）：报表格疑似丢失", () => {
    const warnings = checkParseQuality(doc(15), opts);
    expect(warnings.map((w) => w.kind)).toContain("missing-tables");
  });

  it("提交时表格开关关闭：不报表格丢失", () => {
    const warnings = checkParseQuality(doc(15), { ...opts, enableTable: false });
    expect(warnings.map((w) => w.kind)).not.toContain("missing-tables");
  });

  it("有表格 / 有公式时不报丢失", () => {
    expect(checkParseQuality(doc(15, 3, 1, 1), opts)).toEqual([]);
  });

  it("全文以标题为主：报正文过少（页码范围为 all 才报）", () => {
    const md = Array.from({ length: 8 }, (_, i) => `## 第 ${i + 1} 节`).join("\n\n") + "\n\n一句正文。";
    expect(checkParseQuality(md, opts).map((w) => w.kind)).toContain("sparse");
    expect(
      checkParseQuality(md, { ...opts, pageRange: "1-5" }).map((w) => w.kind),
    ).not.toContain("sparse");
  });

  it("正常全文不报任何警告", () => {
    expect(checkParseQuality(doc(20, 4, 1, 2), opts)).toEqual([]);
  });
});
