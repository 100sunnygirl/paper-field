import { beforeEach, describe, expect, it } from "vitest";
import {
  clearReparseSnapshot,
  completeReparseSnapshot,
  fulltextStats,
  getReparseRecord,
  resetReparseSnapshots,
  saveReparseSnapshot,
} from "./reparse";

beforeEach(() => {
  resetReparseSnapshots();
});

describe("fulltextStats", () => {
  it("统计字数、小节（跳过代码块里的 # 行）、表格块、公式与图片", () => {
    const md = [
      "# 标题",
      "",
      "正文一段，若干字。",
      "",
      "## 方法",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "公式 $x^2$ 与 $$\\int f$$ 以及 \\(y\\)。",
      "",
      "![图 1](img/fig1.png)",
      "",
      "```",
      "# 不是标题",
      "```",
    ].join("\n");
    const stats = fulltextStats(md);
    expect(stats.sections).toBe(2);
    expect(stats.tables).toBe(1);
    // $x^2$ + $$…$$ + \(y\) = 3
    expect(stats.formulas).toBe(3);
    expect(stats.images).toBe(1);
    expect(stats.chars).toBeGreaterThan(0);
  });

  it("空全文给全 0", () => {
    expect(fulltextStats("  \n ")).toEqual({ chars: 0, sections: 0, tables: 0, formulas: 0, images: 0 });
  });
});

describe("重新解析快照", () => {
  it("存快照 → 新版完成后补 next → 清掉", () => {
    saveReparseSnapshot({ paperId: "p1", markdown: "# 旧版", provider: "api" });
    expect(getReparseRecord("p1")).toMatchObject({
      paperId: "p1",
      prev: { markdown: "# 旧版", provider: "api" },
      next: null,
    });
    completeReparseSnapshot("p1", { provider: "local", chars: 120, sections: 3 });
    expect(getReparseRecord("p1")?.next).toMatchObject({ provider: "local", chars: 120, sections: 3 });
    clearReparseSnapshot("p1");
    expect(getReparseRecord("p1")).toBeNull();
  });

  it("同篇重复存快照覆盖旧值；最多保留 3 篇（按最近保存裁最旧）", () => {
    saveReparseSnapshot({ paperId: "a", markdown: "a1", provider: null });
    saveReparseSnapshot({ paperId: "a", markdown: "a2", provider: "ssh" });
    expect(getReparseRecord("a")?.prev.markdown).toBe("a2");
    saveReparseSnapshot({ paperId: "b", markdown: "b", provider: null });
    saveReparseSnapshot({ paperId: "c", markdown: "c", provider: null });
    saveReparseSnapshot({ paperId: "d", markdown: "d", provider: null });
    // 最近保存的 3 篇保留（d、c、b），最早的 a 被裁掉。
    expect(getReparseRecord("a")).toBeNull();
    for (const id of ["b", "c", "d"]) expect(getReparseRecord(id)).not.toBeNull();
  });

  it("localStorage 里的坏数据整条丢弃，不影响其余记录", () => {
    saveReparseSnapshot({ paperId: "ok", markdown: "m", provider: null });
    const raw = JSON.parse(localStorage.getItem("paper-field.reparse-snapshot") ?? "[]") as unknown[];
    raw.push({ paperId: 42, prev: "not-an-object" });
    localStorage.setItem("paper-field.reparse-snapshot", JSON.stringify(raw));
    expect(getReparseRecord("ok")).not.toBeNull();
    expect(getReparseRecord("42")).toBeNull();
  });

  it("未完成新版的快照在补 next 前保持 next=null（界面据此区分进行中 / 可对照）", () => {
    saveReparseSnapshot({ paperId: "p", markdown: "# m", provider: null });
    expect(getReparseRecord("p")?.next).toBeNull();
  });
});
