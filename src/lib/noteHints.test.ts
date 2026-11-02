import { beforeEach, describe, expect, it } from "vitest";
import { NOTE_KINDS } from "./types";
import { NOTE_HINT_QUESTIONS, isNoteHintDismissed, setNoteHintDismissed } from "./noteHints";

beforeEach(() => {
  localStorage.removeItem("paper-field.note-hints");
});

describe("noteHints · 空笔记块的研究问题提示", () => {
  it("五块各有一条提示问题，键覆盖全部 NoteKind", () => {
    expect(Object.keys(NOTE_HINT_QUESTIONS).sort()).toEqual([...NOTE_KINDS].sort());
    for (const kind of NOTE_KINDS) {
      expect(NOTE_HINT_QUESTIONS[kind].length).toBeGreaterThan(4);
    }
  });

  it("默认不关闭；关闭后本机记住", () => {
    expect(isNoteHintDismissed("summary")).toBe(false);
    setNoteHintDismissed("summary", true);
    expect(isNoteHintDismissed("summary")).toBe(true);
    expect(isNoteHintDismissed("weaknesses")).toBe(false);
    expect(JSON.parse(localStorage.getItem("paper-field.note-hints")!).summary).toBe(true);
  });

  it("坏数据被忽略，不抛错", () => {
    localStorage.setItem("paper-field.note-hints", JSON.stringify({ summary: "yes", bogus: true }));
    expect(isNoteHintDismissed("summary")).toBe(false);
    expect(isNoteHintDismissed("remarks")).toBe(false);
    localStorage.setItem("paper-field.note-hints", "{broken");
    expect(isNoteHintDismissed("remarks")).toBe(false);
  });
});
