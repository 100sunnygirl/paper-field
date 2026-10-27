import { describe, expect, it } from "vitest";
import {
  appendExcerpt,
  assignFulltextAnchors,
  buildExcerptMarkdown,
  buildSectionCitation,
  extractFulltextHeadings,
  headingForSelection,
  insertQuoteAtCursor,
} from "./fulltext";

describe("extractFulltextHeadings · 标题层级与编号", () => {
  it("ATX 标题按层级递进编号，深层重置", () => {
    const headings = extractFulltextHeadings("# 引言\n## 方法\n### 细节\n## 结果\n# 结论\n");
    expect(headings.map((h) => h.number)).toEqual(["1", "1.1", "1.1.1", "1.2", "2"]);
    expect(headings.map((h) => h.level)).toEqual([1, 2, 3, 2, 1]);
    expect(headings.map((h) => h.text)).toEqual(["引言", "方法", "细节", "结果", "结论"]);
  });

  it("文档从深层级开始时按该层为第 1 级起算（去掉前导 0 段）", () => {
    const headings = extractFulltextHeadings("## 第一处\n## 第二处\n### 第二处的子节\n");
    expect(headings.map((h) => h.number)).toEqual(["1", "2", "2.1"]);
  });

  it("围栏代码块里的伪标题被跳过", () => {
    const markdown = "# 真标题\n\n```python\n## 这不是标题\n```\n\n## 代码块后的标题\n";
    const headings = extractFulltextHeadings(markdown);
    expect(headings.map((h) => h.text)).toEqual(["真标题", "代码块后的标题"]);
  });

  it("setext 标题（=== / ---）被识别", () => {
    const markdown = "总标题\n======\n\n正文段落。\n\n小节\n----\n";
    const headings = extractFulltextHeadings(markdown);
    expect(headings.map((h) => h.level)).toEqual([1, 2]);
    expect(headings.map((h) => h.text)).toEqual(["总标题", "小节"]);
  });

  it("行内标记（加粗 / 行内代码 / 链接）被剥掉，闭合 # 也被剥掉", () => {
    const headings = extractFulltextHeadings("## **方法**与 `设定` ##\n### [链接标题](https://x.example) 细则\n");
    expect(headings.map((h) => h.text)).toEqual(["方法与 设定", "链接标题 细则"]);
  });

  it("锚点 id 稳定：同一份 Markdown 恒定，正文增删段落不影响；同名标题各得其所", () => {
    const a = extractFulltextHeadings("# A\n## 方法\n# B\n## 方法\n");
    const b = extractFulltextHeadings("新增的正文段落。\n\n# A\n## 方法\n# B\n## 方法\n");
    expect(a.map((h) => h.id)).toEqual(["ft-sec-0", "ft-sec-1", "ft-sec-2", "ft-sec-3"]);
    expect(b.map((h) => h.id)).toEqual(a.map((h) => h.id));
    expect(new Set(a.map((h) => h.id)).size).toBe(4);
  });

  it("空串 / 无标题返回空数组", () => {
    expect(extractFulltextHeadings("")).toEqual([]);
    expect(extractFulltextHeadings("只有正文，没有标题。")).toEqual([]);
  });
});

describe("assignFulltextAnchors · 渲染后补锚点", () => {
  it("按顺序给 h1-h6 挂上稳定 id", () => {
    const root = document.createElement("div");
    root.innerHTML = "<h1>引言</h1><p>正文</p><h2>方法</h2><h3>细节</h3>";
    const headings = extractFulltextHeadings("# 引言\n## 方法\n### 细节\n");
    assignFulltextAnchors(root, headings);
    expect(root.querySelector("h1")?.id).toBe("ft-sec-0");
    expect(root.querySelector("h2")?.id).toBe("ft-sec-1");
    expect(root.querySelector("h3")?.id).toBe("ft-sec-2");
  });

  it("root 为 null 或标题数不匹配时安全跳过", () => {
    expect(() => assignFulltextAnchors(null, [])).not.toThrow();
    const root = document.createElement("div");
    root.innerHTML = "<h1>唯一</h1>";
    assignFulltextAnchors(root, []);
    expect(root.querySelector("h1")?.id).toBe("");
  });
});

describe("headingForSelection · 选中片段归属的小节", () => {
  function setup() {
    const root = document.createElement("div");
    root.innerHTML = "<h2>方法</h2><p>方法正文第一段。</p><h2>结果</h2><p>结果正文第一段。</p>";
    const headings = extractFulltextHeadings("## 方法\n## 结果\n");
    assignFulltextAnchors(root, headings);
    return { root, headings };
  }

  it("选在第二节的正文里 → 归属第二节", () => {
    const { root, headings } = setup();
    const secondPara = root.querySelectorAll("p")[1].firstChild!;
    expect(headingForSelection(root, headings, secondPara)?.text).toBe("结果");
  });

  it("选在第一节的正文里 → 归属第一节", () => {
    const { root, headings } = setup();
    const firstPara = root.querySelectorAll("p")[0].firstChild!;
    expect(headingForSelection(root, headings, firstPara)?.number).toBe("1");
  });

  it("节点不在容器内 / 无标题 → null", () => {
    const { headings } = setup();
    const outside = document.createElement("p");
    document.body.appendChild(outside);
    expect(headingForSelection(outside, headings, outside)).toBeNull();
    expect(headingForSelection(document.createElement("div"), headings, null)).toBeNull();
  });
});

describe("引用文案", () => {
  const heading = extractFulltextHeadings("# 引言\n## 方法设计\n")[1];

  it("章节引用形如「《论文标题》§1.1 方法设计」", () => {
    expect(buildSectionCitation("Visual Instruction Tuning", heading)).toBe(
      "《Visual Instruction Tuning》§1.1 方法设计",
    );
  });

  it("摘录引用带可跳回原文的锚点链接，选中文本空白被压平", () => {
    const markdown = buildExcerptMarkdown("我们  提出\n一种 新方法", heading);
    expect(markdown).toBe("> 原文（[§1.1 方法设计](#ft-sec-1)）：我们 提出 一种 新方法");
  });

  it("无小节归属时退化为「> 原文：…」", () => {
    expect(buildExcerptMarkdown("片段", null)).toBe("> 原文：片段");
  });
});

describe("摘录写入笔记的拼接", () => {
  it("appendExcerpt：空块直接落，有内容先空一行", () => {
    expect(appendExcerpt("", "> 原文：A")).toBe("> 原文：A");
    expect(appendExcerpt("已有内容  ", "> 原文：A")).toBe("已有内容\n\n> 原文：A");
  });

  it("insertQuoteAtCursor：空值直接替换；光标处插入前后按需补空行", () => {
    expect(insertQuoteAtCursor("", 0, "> 原文：A")).toBe("> 原文：A");
    expect(insertQuoteAtCursor("开头", 2, "> 原文：A")).toBe("开头\n\n> 原文：A");
    expect(insertQuoteAtCursor("第一行\n第二行", 4, "> 原文：A")).toBe("第一行\n> 原文：A\n第二行");
    expect(insertQuoteAtCursor("已有\n\n", 4, "> 原文：A")).toBe("已有\n\n> 原文：A");
  });
});
