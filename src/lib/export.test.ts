import { describe, expect, it } from "vitest";
import { assignExportFolders, browserExportFilename, buildDomainExport, libraryExportFilename } from "./export";
import type { Domain, PaperDetail } from "./types";

function makeDomain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: "domain-1",
    name: "多模态",
    code: "MM-01",
    summary: "领域简介",
    sortOrder: 1,
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makePaper(overrides: Partial<PaperDetail> = {}): PaperDetail {
  const id = overrides.id ?? "paper-0001";
  return {
    id,
    domainId: "domain-1",
    title: "Sample Paper",
    titleZh: null,
    abstract: "An abstract.",
    year: 2023,
    venue: "NeurIPS",
    doi: "10.1/sample",
    arxivId: null,
    pdfUrl: null,
    pdfPath: null,
    codeUrl: null,
    codeOpenSource: "open",
    projectPage: null,
    readingStatus: "read",
    readAt: "2024-01-02T00:00:00.000Z",
    llmPreparedAt: null,
    notesDraftedByLlm: false,
    userNotesTouched: false,
    userMetaTouched: false,
    mineruStatus: null,
    mineruParseId: null,
    mineruDocRef: null,
    mineruError: null,
    mineruParseIds: [],
    mineruProvider: null,
    mineruCredFingerprint: null,
    tags: ["tag-a"],
    labs: [{ name: "Liu Lab", institution: "UW-Madison" }],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    authors: [
      { id: "au-1", name: "Haotian Liu", nameZh: null, affiliation: "UW-Madison", lab: "Liu Lab", homepage: null, orcid: null, order: 0, isCorresponding: true },
    ],
    notes: {
      remarks: { id: "n1", paperId: id, kind: "remarks", content: "手动备注内容", source: "manual", userEdited: true, revisedAt: null },
      summary: { id: "n2", paperId: id, kind: "summary", content: "AI 总结内容", source: "llm", userEdited: false, revisedAt: null },
      highlights: { id: "n3", paperId: id, kind: "highlights", content: "AI 亮点，人工又改过", source: "llm", userEdited: true, revisedAt: null },
      weaknesses: { id: "n4", paperId: id, kind: "weaknesses", content: "", source: "manual", userEdited: false, revisedAt: null },
      implications: { id: "n5", paperId: id, kind: "implications", content: "启示", source: "manual", userEdited: false, revisedAt: null },
    },
    domain: makeDomain(),
    parsedMarkdown: "",
    ...overrides,
  };
}

describe("buildDomainExport", () => {
  it("导出文件包含 Labs 字段（name + institution）", () => {
    const files = buildDomainExport(makeDomain(), [makePaper()]);
    const paperFile = files.find((file) => file.relativePath.endsWith(".md") && !file.relativePath.endsWith("README.md"));
    expect(paperFile).toBeDefined();
    expect(paperFile!.content).toContain("- Labs: Liu Lab (UW-Madison)");
  });

  it("笔记标题带来源标注：AI 起草 / AI 起草 · 人工修订 / 手动笔记", () => {
    const files = buildDomainExport(makeDomain(), [makePaper()]);
    const paperFile = files.find((file) => !file.relativePath.endsWith("README.md"))!;
    expect(paperFile.content).toContain("总结 / SUMMARY · AI 起草");
    expect(paperFile.content).toContain("亮点 / HIGHLIGHTS · AI 起草 · 人工修订");
    expect(paperFile.content).toContain("备注 / REMARKS · 手动笔记");
    // 笔记正文保留
    expect(paperFile.content).toContain("AI 总结内容");
  });

  it("同年同题两篇文件名不互相覆盖（后缀去重，缺陷 7）", () => {
    const a = makePaper({ id: "aaaa0001-0000-4000-8000-000000000001" });
    const b = makePaper({ id: "bbbb0002-0000-4000-8000-000000000002" });
    const files = buildDomainExport(makeDomain(), [a, b]);
    const paths = files.map((file) => file.relativePath);
    expect(new Set(paths).size).toBe(paths.length);
    const paperPaths = paths.filter((path) => !path.endsWith("README.md"));
    expect(paperPaths).toHaveLength(2);
    // 第二篇带 id 前缀后缀，两篇正文都能读到
    const bodies = files.filter((file) => !file.relativePath.endsWith("README.md")).map((file) => file.content);
    expect(bodies.every((body) => body.includes("# Sample Paper"))).toBe(true);
    // README 索引引用的文件名与实际文件一一对应
    const readme = files.find((file) => file.relativePath.endsWith("README.md"))!;
    for (const path of paperPaths) {
      expect(readme.content).toContain(`(./${path.split("/").pop()}`);
    }
  });

  it("三篇同年同题也能全部唯一命名", () => {
    const papers = [
      makePaper({ id: "aaaa0001-0000-4000-8000-000000000001" }),
      makePaper({ id: "bbbb0002-0000-4000-8000-000000000002" }),
      makePaper({ id: "cccc0003-0000-4000-8000-000000000003" }),
    ];
    const files = buildDomainExport(makeDomain(), papers);
    const paths = files.map((file) => file.relativePath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("只差大小写的同年标题在不区分大小写的磁盘上也不撞名", () => {
    const papers = [
      makePaper({ id: "aaaa0001-0000-4000-8000-000000000001", title: "Attention" }),
      makePaper({ id: "bbbb0002-0000-4000-8000-000000000002", title: "ATTENTION" }),
    ];
    const paths = buildDomainExport(makeDomain(), papers).map((file) => file.relativePath.toLowerCase());
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("链接字段以 <…> 原样写出，不被转义破坏；非 http(s) 仍按文本转义", () => {
    const body = buildDomainExport(makeDomain(), [
      makePaper({ codeUrl: "https://github.com/a_b/c_d", projectPage: "javascript:alert(1)//_x_" }),
    ])[1].content;
    expect(body).toContain("- Code: <https://github.com/a_b/c_d>");
    expect(body).toContain("- Project: javascript:alert(1)//\\_x\\_");
  });

  it("中文标题进入文件名 slug，领域目录取 code", () => {
    const files = buildDomainExport(makeDomain(), [makePaper({ title: "视觉指令微调", year: null })], new Date(2026, 0, 2, 3, 4, 5));
    expect(files[0].relativePath).toBe("MM-01-20260102-030405/README.md");
    expect(files[1].relativePath).toBe("MM-01-20260102-030405/n-视觉指令微调.md");
  });

  it("浏览器下载名是小写领域代码加 export.md，而不是 download", () => {
    expect(browserExportFilename(makeDomain())).toBe("mm-01-export.md");
    expect(browserExportFilename(makeDomain({ code: "", name: "多模态" }))).toBe("多模态-export.md");
    expect(libraryExportFilename(new Date(2026, 0, 2, 3, 4, 5))).toBe("paper-field-20260102-030405.md");
  });

  it("同名领域目录追加 id 前四位，再追加序号，不改 README 正文", () => {
    const now = new Date(2026, 0, 2, 3, 4, 5);
    const first = buildDomainExport(makeDomain({ id: "abcd-1", code: "MM-01" }), [], now);
    const second = buildDomainExport(makeDomain({ id: "WXYZ-2", code: "mm-01" }), [], now);
    const third = buildDomainExport(makeDomain({ id: "wxyz-3", code: "MM-01" }), [makePaper({ id: "p-3" })], now);
    const files = assignExportFolders([
      { domainId: "abcd-1", files: first },
      { domainId: "WXYZ-2", files: second },
      { domainId: "wxyz-3", files: third },
    ]);
    const folders = files.filter((file) => file.relativePath.endsWith("README.md")).map((file) => file.relativePath.split("/")[0]);
    expect(folders).toEqual([
      "MM-01-20260102-030405",
      "mm-01-20260102-030405-wxyz",
      "MM-01-20260102-030405-wxyz-2",
    ]);
    expect(files.find((file) => file.relativePath.startsWith("mm-01-20260102-030405-wxyz/"))!.content).toBe(second[0].content);
    expect(files.some((file) => file.relativePath.startsWith("MM-01-20260102-030405-wxyz-2/") && !file.relativePath.endsWith("README.md"))).toBe(true);
  });

  it("README 索引包含标题与阅读状态", () => {
    const files = buildDomainExport(makeDomain(), [makePaper()]);
    const readme = files.find((file) => file.relativePath.endsWith("README.md"))!;
    expect(readme.content).toContain("1. [Sample Paper](");
    expect(readme.content).toContain("— read");
  });
});

describe("export folder never reuses an existing name", () => {
  it("suffixes the domain folder with a local timestamp", () => {
    const files = buildDomainExport(makeDomain(), [makePaper()], new Date(2026, 9, 13, 9, 5, 7));
    for (const f of files) expect(f.relativePath.split("/")[0]).toMatch(/-20261013-090507$/);
  });

  it("two exports a second apart go to different folders", () => {
    const a = buildDomainExport(makeDomain(), [makePaper()], new Date(2026, 0, 1, 0, 0, 0));
    const b = buildDomainExport(makeDomain(), [makePaper()], new Date(2026, 0, 1, 0, 0, 1));
    expect(a[0].relativePath.split("/")[0]).not.toBe(b[0].relativePath.split("/")[0]);
  });
});

describe("导出 markdown 不让元数据注入结构（SEC-013）", () => {
  const paperBody = (paper: PaperDetail) =>
    buildDomainExport(makeDomain(), [paper]).find((file) => !file.relativePath.endsWith("README.md"))!.content;

  it("单行元数据里的换行被压平，不能注入标题或列表项", () => {
    const body = paperBody(
      makePaper({ title: "Real\n# Injected\n- Status: fake", venue: "Conf\r\n## Notes", tags: ["a\n# b"] }),
    );
    const lines = body.split("\n");
    // 压成一行后 # 与 - 不在行首，只是普通字符。
    expect(lines[0]).toBe("# Real # Injected - Status: fake");
    expect(lines.filter((line) => line.startsWith("#") && line.includes("Injected"))).toHaveLength(1);
    expect(body).toContain("- Venue: Conf ## Notes");
    expect(body).not.toMatch(/^## Notes/m);
    expect(body).toContain("- Tags: a # b");
    expect(paperBody(makePaper({ titleZh: "\n# 标题" }))).toContain("> \\# 标题");
  });

  it("元数据里的 HTML 与 markdown 链接被转义成字面文本", () => {
    const body = paperBody(
      makePaper({
        title: '<img src=x onerror="alert(1)">',
        venue: "[click](javascript:alert(1))",
        authors: [{ id: "a", name: "<script>x</script>", nameZh: null, affiliation: "**Bold**", lab: null, homepage: null, orcid: null, order: 0, isCorresponding: false }],
      }),
    );
    expect(body).not.toMatch(/(^|[^\\])<(img|script)/);
    expect(body).toContain("# \\<img src=x onerror=\"alert(1)\"\\>");
    expect(body).toContain("- Venue: \\[click\\](javascript:alert(1))");
    expect(body).toContain("\\*\\*Bold\\*\\*");
  });

  it("摘要保留换行但逐行转义，不能起标题或插入 HTML", () => {
    const body = paperBody(makePaper({ abstract: "First line.\n# Heading\n<iframe src=x></iframe>" }));
    expect(body).toContain("First line.\n\\# Heading\n\\<iframe src=x\\>\\</iframe\\>");
  });

  it("笔记正文保留 markdown，只中和代码之外的原始 HTML", () => {
    const content = "**要点**\n- [链接](https://example.com)\n<img src=x onerror=alert(1)>\n<!-- c -->\n```html\n<b>代码</b>\n```\na < b";
    const body = paperBody(
      makePaper({ notes: { ...makePaper().notes, summary: { ...makePaper().notes.summary, content } } }),
    );
    expect(body).toContain("**要点**\n- [链接](https://example.com)\n\\<img src=x onerror=alert(1)>\n\\<!-- c -->");
    expect(body).toContain("```html\n<b>代码</b>\n```\na < b");
  });

  it("围栏内藏 \\r 换行或伪造的开栏都不能放过 HTML", () => {
    const tricks = ["```\r```\r<img src=x onerror=alert(1)>", "``` a`b\n<img src=x onerror=alert(1)>", "  ```\n<img src=x onerror=alert(1)>"];
    for (const content of tricks) {
      const body = paperBody(
        makePaper({ notes: { ...makePaper().notes, summary: { ...makePaper().notes.summary, content } } }),
      );
      expect(body).toContain("\\<img src=x");
    }
  });

  it("PDF 只导出库内文件名，不泄露本机绝对路径", () => {
    expect(paperBody(makePaper({ pdfPath: "/Users/alice/Library/PaperField/pdfs/abc.pdf" }))).toContain("- PDF: abc.pdf");
    const win = paperBody(makePaper({ pdfPath: "C:\\Users\\alice\\AppData\\pdfs\\x_y.pdf" }));
    expect(win).toContain("- PDF: x\\_y.pdf");
    expect(win).not.toContain("alice");
    expect(paperBody(makePaper({ pdfUrl: "https://arxiv.org/pdf/1" }))).toContain("- PDF: <https://arxiv.org/pdf/1");
  });

  it("README 索引里的标题与领域名同样转义", () => {
    const files = buildDomainExport(makeDomain({ name: "多模态\n# x", summary: "<b>s</b>" }), [makePaper({ title: "A](evil) [B" })]);
    const readme = files[0].content;
    expect(readme.split("\n")[0]).toBe("# 多模态 # x / MM-01");
    expect(readme).toContain("\\<b\\>s\\</b\\>");
    expect(readme).toContain("1. [A\\](evil) \\[B](./");
  });
});
