import { describe, expect, it } from "vitest";
import {
  cleanPdfTitle,
  extractArxivFromFilename,
  looksLikeNonPaper,
  normalizeTitleForMatch,
  scanImportItem,
  titleSimilarity,
  type PaperRef,
} from "./importScan";

describe("looksLikeNonPaper · 非论文预判", () => {
  it("课件 / 习题答案 / 试卷 / 表单等强信号词命中", () => {
    expect(looksLikeNonPaper("week3-lecture-slides.pdf")).toBe(true);
    expect(looksLikeNonPaper("第3讲 课件.pdf")).toBe(true);
    expect(looksLikeNonPaper("2017期末试卷A.pdf")).toBe(true);
    expect(looksLikeNonPaper("习题答案 chapter5.pdf")).toBe(true);
    expect(looksLikeNonPaper("报销发票-2024.pdf")).toBe(true);
    expect(looksLikeNonPaper("报名表-v2.pdf")).toBe(true);
    expect(looksLikeNonPaper("problem-set1.pdf")).toBe(true);
  });

  it("两可词不误伤正常论文", () => {
    expect(looksLikeNonPaper("Attention Is All You Need.pdf")).toBe(false);
    expect(looksLikeNonPaper("notes on diffusion models.pdf")).toBe(false);
    expect(looksLikeNonPaper("1706.03762 attention.pdf")).toBe(false);
    expect(looksLikeNonPaper("A Survey of Retrieval-Augmented Generation.pdf")).toBe(false);
  });
});

function ref(overrides: Partial<PaperRef> = {}): PaperRef {
  return {
    id: "p-1",
    title: "Attention Is All You Need",
    titleZh: null,
    arxivId: null,
    doi: null,
    domainId: "d-1",
    domainName: "多模态",
    pdfPath: null,
    pdfOriginalPath: null,
    ...overrides,
  };
}

describe("extractArxivFromFilename", () => {
  it("识别裸号、带版本、arXiv 前缀与方括号写法", () => {
    expect(extractArxivFromFilename("1706.03762.pdf")).toBe("1706.03762");
    expect(extractArxivFromFilename("2310.06692v3 Attention.pdf")).toBe("2310.06692");
    expect(extractArxivFromFilename("arXiv_2401.12345_Scaling Laws.pdf")).toBe("2401.12345");
    expect(extractArxivFromFilename("[2310.06692] some paper.pdf")).toBe("2310.06692");
  });

  it("不像 arXiv 号的数字不误判", () => {
    expect(extractArxivFromFilename("2023 annual report.pdf")).toBeNull();
    expect(extractArxivFromFilename("notes v2.pdf")).toBeNull();
    expect(extractArxivFromFilename("12345.678.pdf")).toBeNull();
  });
});

describe("cleanPdfTitle", () => {
  it("去扩展名、去开头 arXiv 号、下划线折空格", () => {
    expect(cleanPdfTitle("1706.03762 Attention Is All You Need.pdf")).toBe("Attention Is All You Need");
    expect(cleanPdfTitle("arXiv_2401.12345_Scaling_Laws.pdf")).toBe("Scaling Laws");
    expect(cleanPdfTitle("my_paper_notes.pdf")).toBe("my paper notes");
  });

  it("认不出的写法原样保留", () => {
    expect(cleanPdfTitle("Some Paper 2024.pdf")).toBe("Some Paper 2024");
    expect(cleanPdfTitle(".pdf")).toBeNull();
  });
});

describe("titleSimilarity / normalizeTitleForMatch", () => {
  it("归一忽略大小写、标点与全角", () => {
    expect(normalizeTitleForMatch("Attention: Is  All-You-Need!")).toBe(
      normalizeTitleForMatch("attention is all you need"),
    );
  });

  it("Dice 相似度：同标题为 1，无关标题接近 0", () => {
    const a = normalizeTitleForMatch("Attention Is All You Need");
    expect(titleSimilarity(a, normalizeTitleForMatch("Attention Is ALL You Need"))).toBe(1);
    expect(titleSimilarity(a, normalizeTitleForMatch("A Study of Graph Neural Networks"))).toBeLessThan(0.4);
  });
});

describe("scanImportItem · 重复候选", () => {
  it("arXiv 号一致命中（跨领域也报），依据写明编号", () => {
    const refs = [ref({ arxivId: "1706.03762", domainId: "d-2", domainName: "指令对齐" })];
    const scan = scanImportItem("1706.03762v2 copy.pdf", refs);
    expect(scan.arxivId).toBe("1706.03762");
    expect(scan.candidate).toMatchObject({
      paperId: "p-1",
      basis: "arxiv",
      domainName: "指令对齐",
      detail: "arXiv 1706.03762 相同",
    });
  });

  it("清洗后的标题与库内标题一致（含中文标题）命中", () => {
    const refs = [ref({ title: "Attention Is All You Need", titleZh: "注意力机制综述" })];
    const scan = scanImportItem("Attention_Is_All_You_Need.pdf", refs);
    expect(scan.candidate).toMatchObject({ basis: "title", detail: "标题一致" });

    const zhScan = scanImportItem("注意力机制综述.pdf", refs);
    expect(zhScan.candidate).toMatchObject({ basis: "title", paperId: "p-1" });
  });

  it("标题高度相似（换分隔与大小写）报「标题相似」", () => {
    const refs = [ref({ title: "Scaling Laws for Neural Language Models" })];
    const scan = scanImportItem("scaling laws for neural language models (v2).pdf", refs);
    expect(scan.candidate).toMatchObject({ basis: "title", detail: "标题相似" });
  });

  it("无关文件不误报候选；短文件名不参与相似比对", () => {
    const refs = [ref()];
    expect(scanImportItem("lecture notes day 1.pdf", refs).candidate).toBeNull();
    expect(scanImportItem("abc.pdf", refs).candidate).toBeNull();
  });

  it("arXiv 依据优先于标题依据", () => {
    const refs = [ref({ title: "Totally Different Title", arxivId: "1706.03762" })];
    const scan = scanImportItem("1706.03762 Totally Different Title.pdf", refs);
    expect(scan.candidate?.basis).toBe("arxiv");
  });
});
