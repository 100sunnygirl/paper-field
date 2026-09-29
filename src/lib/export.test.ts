import { describe, expect, it } from "vitest";
import { buildDomainExport } from "./export";
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

  it("中文标题进入文件名 slug，领域目录取 code", () => {
    const files = buildDomainExport(makeDomain(), [makePaper({ title: "视觉指令微调", year: null })]);
    expect(files[0].relativePath).toBe("MM-01/README.md");
    expect(files[1].relativePath).toBe("MM-01/n-视觉指令微调.md");
  });

  it("README 索引包含标题与阅读状态", () => {
    const files = buildDomainExport(makeDomain(), [makePaper()]);
    const readme = files.find((file) => file.relativePath.endsWith("README.md"))!;
    expect(readme.content).toContain("1. [Sample Paper](");
    expect(readme.content).toContain("— read");
  });
});
