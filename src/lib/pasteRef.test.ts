import { describe, expect, it } from "vitest";
import { parsePastedRef } from "./pasteRef";

describe("parsePastedRef · arXiv 识别", () => {
  it("裸 arXiv 号与带版本号", () => {
    expect(parsePastedRef("1706.03762")).toEqual({ kind: "arxiv", arxivId: "1706.03762" });
    expect(parsePastedRef("2310.06692v3")).toEqual({ kind: "arxiv", arxivId: "2310.06692" });
  });

  it("arXiv: 前缀与 abs/pdf 链接", () => {
    expect(parsePastedRef("arXiv:2401.12345")).toEqual({ kind: "arxiv", arxivId: "2401.12345" });
    expect(parsePastedRef("https://arxiv.org/abs/1706.03762v7")).toEqual({ kind: "arxiv", arxivId: "1706.03762" });
    expect(parsePastedRef("http://arxiv.org/pdf/2403.00001.pdf")).toEqual({ kind: "arxiv", arxivId: "2403.00001" });
  });

  it("全角冒号等输入法残留同样识别", () => {
    expect(parsePastedRef("arxiv：1706.03762")).toEqual({ kind: "arxiv", arxivId: "1706.03762" });
  });
});

describe("parsePastedRef · DOI 识别", () => {
  it("裸 DOI 与 doi: 前缀", () => {
    expect(parsePastedRef("10.1038/s41586-024-07306-0")).toEqual({ kind: "doi", doi: "10.1038/s41586-024-07306-0" });
    expect(parsePastedRef("doi:10.5555/12345678")).toEqual({ kind: "doi", doi: "10.5555/12345678" });
  });

  it("doi.org 链接（含句尾标点剥除）", () => {
    expect(parsePastedRef("https://doi.org/10.1109/CVPR.2024.00123.")).toEqual({
      kind: "doi",
      doi: "10.1109/CVPR.2024.00123",
    });
  });
});

describe("parsePastedRef · BibTeX 解析", () => {
  const BIB = `@article{vaswani2017attention,
    title = {Attention Is All You Need},
    author = {Vaswani, Ashish and Shazeer, Noam},
    journal = {Advances in Neural Information Processing Systems},
    year = {2017},
    doi = {10.5555/3294771.3295384},
  }`;

  it("拆出标题、作者、年份、出处与 DOI", () => {
    const ref = parsePastedRef(BIB)!;
    expect(ref).not.toBeNull();
    expect(ref.kind).toBe("bibtex");
    expect(ref.title).toBe("Attention Is All You Need");
    expect(ref.authors).toEqual(["Vaswani, Ashish", "Shazeer, Noam"]);
    expect(ref.year).toBe(2017);
    expect(ref.venue).toBe("Advances in Neural Information Processing Systems");
    expect(ref.doi).toBe("10.5555/3294771.3295384");
  });

  it("eprint + archivePrefix 识别 arXiv；booktitle 作为出处", () => {
    const ref = parsePastedRef(
      `@inproceedings{foo,
        title = "Scaling Laws {Neural} Language Models",
        booktitle = "ICML",
        year = 2020,
        eprint = "2001.08361",
        archivePrefix = {arXiv},
      }`,
    )!;
    expect(ref.kind).toBe("bibtex");
    expect(ref.title).toBe("Scaling Laws Neural Language Models");
    expect(ref.venue).toBe("ICML");
    expect(ref.arxivId).toBe("2001.08361");
    expect(ref.year).toBe(2020);
  });

  it("值里的逗号与嵌套花括号不撕裂字段", () => {
    const ref = parsePastedRef(
      `@misc{key,
        title = {Deep {Learning, and Beyond}},
        year = {2024},
      }`,
    )!;
    expect(ref.title).toBe("Deep Learning, and Beyond");
    expect(ref.year).toBe(2024);
  });

  it("字段名大小写不敏感；未终止的条目也能尽力解析", () => {
    const ref = parsePastedRef(`@Article{x, TITLE={Alpha Beta}, Year={2023}`)!;
    expect(ref.title).toBe("Alpha Beta");
    expect(ref.year).toBe(2023);
  });
});

describe("parsePastedRef · 识别不了与优先级", () => {
  it("普通文字与空串返回 null", () => {
    expect(parsePastedRef("")).toBeNull();
    expect(parsePastedRef("随便一句话")).toBeNull();
    expect(parsePastedRef("Attention is all you need")).toBeNull();
  });

  it("BibTeX 优先于文中顺带出现的 arXiv 号", () => {
    const ref = parsePastedRef(`@article{a, title={T}, eprint={2401.00001}, archivePrefix={arXiv}}`)!;
    expect(ref.kind).toBe("bibtex");
    expect(ref.arxivId).toBe("2401.00001");
    expect(ref.title).toBe("T");
  });
});
