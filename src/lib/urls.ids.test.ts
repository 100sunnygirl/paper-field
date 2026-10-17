import { describe, expect, it } from "vitest";
import { normalizeArxivId, normalizeDoi } from "./urls";

describe("arXiv / DOI 规整（与 Rust 侧 ArxivId / Doi 一致）", () => {
  it.each([
    ["arXiv：2401.01234", "2401.01234"],
    ["arxiv: 2401.01234v2", "2401.01234"],
    ["　ARXIV:2401.01234 ", "2401.01234"],
    ["２４０１.０１２３４", "2401.01234"],
    ["arxiv.org/abs/2401.01234", "2401.01234"],
    ["https://www.arxiv.org/pdf/2401.01234v3.pdf", "2401.01234"],
    ["hep-th/9901001", "hep-th/9901001"],
  ])("arXiv %s → %s", (input, out) => {
    expect(normalizeArxivId(input)).toBe(out);
  });

  it.each(["", "2401", "arXiv：", "not an id", "https://example.org/abs/2401.01234"])("arXiv %s → null", (input) => {
    expect(normalizeArxivId(input)).toBeNull();
  });

  it.each([
    ["doi:10.1000/xyz", "10.1000/xyz"],
    ["DOI: 10.1000/xyz", "10.1000/xyz"],
    ["HTTPS://DOI.ORG/10.1000/xyz", "10.1000/xyz"],
    ["https://www.doi.org/10.1000/xyz", "10.1000/xyz"],
    ["doi.org/10.1000/xyz", "10.1000/xyz"],
    ["http://dx.doi.org/10.1000/ABC", "10.1000/ABC"],
  ])("DOI %s → %s", (input, out) => {
    expect(normalizeDoi(input)).toBe(out);
  });
});
