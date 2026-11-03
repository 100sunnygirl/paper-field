import { beforeEach, describe, expect, it } from "vitest";
import { deferPaper, deferredPaperIds, undeferPaper } from "./deferredPapers";

beforeEach(() => {
  localStorage.removeItem("paper-field.intake-deferred");
});

describe("deferredPapers · 暂缓处理（本机）", () => {
  it("加入去重、恢复、清空", () => {
    expect(deferredPaperIds()).toEqual([]);
    deferPaper("a");
    deferPaper("a");
    deferPaper("b");
    expect(deferredPaperIds()).toEqual(["a", "b"]);
    undeferPaper("a");
    expect(deferredPaperIds()).toEqual(["b"]);
    undeferPaper("b");
    expect(deferredPaperIds()).toEqual([]);
  });

  it("坏数据容错", () => {
    localStorage.setItem("paper-field.intake-deferred", JSON.stringify(["a", 2, null]));
    expect(deferredPaperIds()).toEqual(["a"]);
    localStorage.setItem("paper-field.intake-deferred", "{oops");
    expect(deferredPaperIds()).toEqual([]);
  });
});
