import { beforeEach, describe, expect, it } from "vitest";
import {
  listImportFailures,
  recordImportFailures,
  removeImportFailure,
  resetImportFailures,
  resolveImportFailures,
  type ImportFailureEntry,
} from "./importFailures";

function entry(path: string, overrides: Partial<ImportFailureEntry> = {}): ImportFailureEntry {
  return {
    path,
    name: path.split("/").pop() ?? path,
    domainId: "d-1",
    message: "磁盘已满",
    at: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("importFailures · 本机持久化失败清单", () => {
  it("记录后可列出，重启（重新读取）仍在", () => {
    recordImportFailures([entry("/x/bad.pdf", { message: "PDF 不存在" })]);
    expect(listImportFailures()).toEqual([entry("/x/bad.pdf", { message: "PDF 不存在" })]);
  });

  it("同路径覆盖旧记录（重试再失败时更新原因与时间）", () => {
    recordImportFailures([entry("/x/bad.pdf", { message: "第一次", at: 1 })]);
    recordImportFailures([entry("/x/bad.pdf", { message: "第二次", at: 2 })]);
    const list = listImportFailures();
    expect(list).toHaveLength(1);
    expect(list[0].message).toBe("第二次");
    expect(list[0].at).toBe(2);
  });

  it("resolveImportFailures 移出落定路径，未知路径忽略", () => {
    recordImportFailures([entry("/x/a.pdf"), entry("/x/b.pdf")]);
    resolveImportFailures(["/x/a.pdf", "/x/never.pdf"]);
    expect(listImportFailures().map((e) => e.path)).toEqual(["/x/b.pdf"]);
  });

  it("removeImportFailure 逐条移除；resetImportFailures 清空", () => {
    recordImportFailures([entry("/x/a.pdf"), entry("/x/b.pdf")]);
    removeImportFailure("/x/a.pdf");
    expect(listImportFailures().map((e) => e.path)).toEqual(["/x/b.pdf"]);
    resetImportFailures();
    expect(listImportFailures()).toEqual([]);
  });

  it("超过上限时裁掉最旧的条目", () => {
    const many = Array.from({ length: 45 }, (_, i) => entry(`/x/f${i}.pdf`, { at: i }));
    recordImportFailures(many);
    const list = listImportFailures();
    expect(list).toHaveLength(40);
    expect(list[0].path).toBe("/x/f5.pdf");
    expect(list.at(-1)?.path).toBe("/x/f44.pdf");
  });

  it("坏 JSON 与非法条目安全忽略", () => {
    localStorage.setItem("paper-field.import-failures", JSON.stringify([{ path: 1 }, "junk"]));
    expect(listImportFailures()).toEqual([]);
    localStorage.setItem("paper-field.import-failures", "not json");
    expect(listImportFailures()).toEqual([]);
  });
});
