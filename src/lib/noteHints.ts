import { NOTE_KINDS, type NoteKind } from "./types";

/**
 * 空笔记块的研究问题提示：给「不知道从哪开始写」的五块各配一个切入点，
 * 可逐块关闭（本机 localStorage 记住，之后不再打扰）；点击「写…」仍从空白开写。
 */
export const NOTE_HINT_QUESTIONS: Record<NoteKind, string> = {
  summary: "用一句话概括：这篇论文解决了什么问题，答案是什么？",
  highlights: "哪些方法或结果让你眼前一亮？它为什么有效？",
  weaknesses: "实验没有覆盖哪些条件？结论有没有超出数据能支撑的范围？",
  implications: "它对你的研究有什么启发？哪些思路可以借到你的问题上？",
  remarks: "还想记点什么？引用、待查的文献、和谁讨论过，都行。",
};

const KEY = "paper-field.note-hints";

function load(): Partial<Record<NoteKind, boolean>> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return {};
    const dismissed: Partial<Record<NoteKind, boolean>> = {};
    for (const kind of NOTE_KINDS) {
      const flag = (value as Record<string, unknown>)[kind];
      if (typeof flag === "boolean") dismissed[kind] = flag;
    }
    return dismissed;
  } catch {
    return {};
  }
}

/** 这一块的提示是否已被本机关闭。 */
export function isNoteHintDismissed(kind: NoteKind): boolean {
  return load()[kind] === true;
}

/** 关闭 / 恢复一块的提示（写穿 localStorage；存不下时仅本会话生效）。 */
export function setNoteHintDismissed(kind: NoteKind, dismissed: boolean): void {
  const next = { ...load(), [kind]: dismissed };
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 存不下（隐私模式等）：本次会话内组件自己的 state 已生效。
  }
}
