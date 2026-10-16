import { describe, expect, it } from "vitest";
import {
  draftNotesUserPrompt,
  normalizeMeta,
  normalizeNotes,
  prepareMetaUserPrompt,
} from "./prompts";
import type { PaperDetail, PreparedMeta } from "./types";
import { extractJson } from "./util";

/** 模型返回的 JSON 常带围栏 / 前后噪声：extractJson 必须容错截取。 */
describe("extractJson 解析容错", () => {
  it("纯 JSON 直接解析", () => {
    expect(extractJson<{ a: 1 }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("带 ```json 围栏的返回被剥出", () => {
    const raw = '```json\n{"title":"x","year":2024}\n```';
    expect(extractJson<{ title: string }>(raw)).toEqual({ title: "x", year: 2024 });
  });

  it("带前后噪声文本的返回截取首个 { 到最后一个 }", () => {
    const raw = '好的，以下是结果：{"title":"y"} 希望有帮助';
    expect(extractJson<{ title: string }>(raw)).toEqual({ title: "y" });
  });

  it("完全没有 JSON 时抛「模型未返回可解析 JSON」", () => {
    expect(() => extractJson("抱歉，我无法处理")).toThrow("模型未返回可解析 JSON");
  });

  it("花括号不成对（只有 {）时同样抛错", () => {
    expect(() => extractJson('prefix {"title":"z"')).toThrow("模型未返回可解析 JSON");
  });
});

describe("normalizeMeta 容错", () => {
  const base = {} as PreparedMeta;

  it("缺 title 时保持为空，不再用当前标题兜底", () => {
    expect(normalizeMeta({ ...base, title: "" }).title).toBe("");
    expect(normalizeMeta({ ...base, title: "  " }).title).toBe("");
  });

  it("字段类型不对时不抛错：数字转文本，对象当空", () => {
    const meta = normalizeMeta({
      ...base,
      title: "t",
      titleZh: 42 as unknown as string,
      venue: { a: 1 } as unknown as string,
      authors: [{ name: 7 }] as unknown as PreparedMeta["authors"],
      tags: [{ x: 1 }, "ok"] as unknown as string[],
    });
    expect(meta.titleZh).toBe("42");
    expect(meta.venue).toBeNull();
    expect(meta.authors.map((a) => a.name)).toEqual(["7"]);
    expect(meta.tags).toEqual(["ok"]);
  });

  it("year 非数字（如字符串 “2024” 或 undefined）归 null", () => {
    expect(normalizeMeta({ ...base, title: "t", year: "2024" } as unknown as PreparedMeta).year).toBeNull();
    expect(normalizeMeta({ ...base, title: "t", year: undefined } as unknown as PreparedMeta).year).toBeNull();
    expect(normalizeMeta({ ...base, title: "t", year: 2024 }).year).toBe(2024);
  });

  it("非法 codeOpenSource 归 unknown，合法值透传", () => {
    expect(normalizeMeta({ ...base, title: "t", codeOpenSource: "maybe" as never }).codeOpenSource).toBe("unknown");
    expect(normalizeMeta({ ...base, title: "t", codeOpenSource: "open" }).codeOpenSource).toBe("open");
    expect(normalizeMeta({ ...base, title: "t", codeOpenSource: "request" }).codeOpenSource).toBe("request");
  });

  it("authors/labs 非数组时归空数组，缺名字的条目被过滤", () => {
    const meta = normalizeMeta(
      {
        ...base,
        title: "t",
        authors: [{ affiliation: "MIT" }, { name: "Alice" }] as PreparedMeta["authors"],
        labs: [{ institution: "X" }, { name: "Lab" }] as unknown as PreparedMeta["labs"],
      },
    );
    expect(meta.authors.map((a) => a.name)).toEqual(["Alice"]);
    expect(meta.labs).toEqual([{ name: "Lab", institution: "" }]);
    expect(normalizeMeta({ ...base, title: "t", authors: "bad" as unknown as PreparedMeta["authors"] }).authors).toEqual([]);
  });

  it("空串字段归 null（venue/doi/arxivId 等），tags 只收文本与数字", () => {
    const meta = normalizeMeta(
      { ...base, title: "t", venue: "", doi: "", arxivId: "", tags: [1, "b", null] as unknown as string[] },
    );
    expect(meta.venue).toBeNull();
    expect(meta.doi).toBeNull();
    expect(meta.arxivId).toBeNull();
    expect(meta.tags).toEqual(["1", "b"]);
  });
});

describe("normalizeNotes 容错", () => {
  it("缺失字段归空串", () => {
    const notes = normalizeNotes({} as never);
    expect(notes).toEqual({ remarks: "", summary: "", highlights: "", weaknesses: "", implications: "" });
  });

  it("已有字段透传", () => {
    const notes = normalizeNotes({ remarks: "r", summary: "s", highlights: "h", weaknesses: "w", implications: "i" });
    expect(notes.summary).toBe("s");
  });
});

describe("用户 prompt 组装", () => {
  it("prepareMetaUserPrompt：标题/arXiv/DOI/PDF 路径/摘要/markdown 全带，长文截断", () => {
    const long = "x".repeat(13000);
    const prompt = prepareMetaUserPrompt({
      title: "T",
      arxivId: "2301.00001",
      doi: "10.1/x",
      pdfPath: "/local/a.pdf",
      pdfUrl: "https://example.com/a.pdf",
      abstract: "abs",
      parsedMarkdown: long,
    });
    expect(prompt).toContain("Title: T");
    expect(prompt).toContain("arXiv: 2301.00001");
    expect(prompt).toContain("DOI: 10.1/x");
    expect(prompt).not.toContain("/local/a.pdf");
    expect(prompt).not.toContain("Local PDF");
    expect(prompt).toContain("Public PDF: https://example.com/a.pdf");
    expect(prompt).toContain("Abstract already on file:\nabs");
    expect(prompt).toContain("MinerU markdown:\n");
    expect(prompt).toContain("[truncated]");
    expect(prompt.length).toBeLessThan(long.length);
  });

  it("prepareMetaUserPrompt：空字段省略对应行", () => {
    const prompt = prepareMetaUserPrompt({ title: "Only Title" });
    expect(prompt).toBe("Title: Only Title");
  });

  it("draftNotesUserPrompt：作者与机构并入 prompt", () => {
    const paper = {
      title: "T",
      titleZh: null,
      year: 2023,
      venue: "V",
      abstract: "A",
      parsedMarkdown: "",
      tags: ["x"],
      authors: [
        { id: "a", name: "Alice", nameZh: null, affiliation: "MIT", lab: null, homepage: null, orcid: null, order: 0, isCorresponding: false },
        { id: "b", name: "Bob", nameZh: null, affiliation: null, lab: null, homepage: null, orcid: null, order: 1, isCorresponding: false },
      ],
    } as unknown as PaperDetail;
    const prompt = draftNotesUserPrompt(paper);
    expect(prompt).toContain("Authors: Alice (MIT); Bob");
    expect(prompt).toContain("Tags: x");
    expect(prompt).toContain("Abstract:\nA");
  });
});
