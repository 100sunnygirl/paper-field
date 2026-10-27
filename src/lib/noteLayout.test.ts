import { beforeEach, describe, expect, it } from "vitest";
import { NOTE_DISPLAY_ORDER } from "./types";
import { loadNoteLayout, moveNoteKind, saveNoteLayout } from "./noteLayout";

beforeEach(() => {
  localStorage.clear();
});

describe("noteLayout · 读取与持久化", () => {
  it("默认为标准顺序、全部展开", () => {
    const layout = loadNoteLayout();
    expect(layout.order).toEqual(NOTE_DISPLAY_ORDER);
    expect(layout.collapsed).toEqual({});
  });

  it("保存后重新读取生效（顺序 + 折叠状态）", () => {
    saveNoteLayout({
      order: ["remarks", "summary", "highlights", "weaknesses", "implications"],
      collapsed: { remarks: true, summary: false },
    });
    const layout = loadNoteLayout();
    expect(layout.order[0]).toBe("remarks");
    expect(layout.collapsed.remarks).toBe(true);
    expect(layout.collapsed.summary).toBe(false);
    expect(layout.collapsed.highlights).toBeUndefined();
  });

  it("坏数据回落默认：非 JSON / 顺序缺块多块 / 折叠值类型错", () => {
    localStorage.setItem("paper-field.note-layout", "not-json");
    expect(loadNoteLayout().order).toEqual(NOTE_DISPLAY_ORDER);
    localStorage.setItem(
      "paper-field.note-layout",
      JSON.stringify({ order: ["summary", "highlights"], collapsed: "yes" }),
    );
    const layout = loadNoteLayout();
    expect(layout.order).toEqual(NOTE_DISPLAY_ORDER);
    expect(layout.collapsed).toEqual({});
  });
});

describe("noteLayout · 上移 / 下移", () => {
  it("中间块上下移各交换一位", () => {
    expect(moveNoteKind(NOTE_DISPLAY_ORDER, "weaknesses", "up")).toEqual([
      "summary",
      "weaknesses",
      "highlights",
      "implications",
      "remarks",
    ]);
    expect(moveNoteKind(NOTE_DISPLAY_ORDER, "summary", "down")).toEqual([
      "highlights",
      "summary",
      "weaknesses",
      "implications",
      "remarks",
    ]);
  });

  it("首块上移 / 末块下移不动；未知块不动", () => {
    expect(moveNoteKind(NOTE_DISPLAY_ORDER, "summary", "up")).toEqual(NOTE_DISPLAY_ORDER);
    expect(moveNoteKind(NOTE_DISPLAY_ORDER, "remarks", "down")).toEqual(NOTE_DISPLAY_ORDER);
    expect(moveNoteKind(NOTE_DISPLAY_ORDER, "nonsense" as never, "up")).toEqual(NOTE_DISPLAY_ORDER);
  });
});
