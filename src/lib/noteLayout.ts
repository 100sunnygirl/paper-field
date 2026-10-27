import { NOTE_DISPLAY_ORDER, NOTE_KINDS, type NoteKind } from "./types";

/**
 * 五块笔记的显示布局（本机偏好，localStorage 持久化）：
 * - order：块的显示顺序（必须仍是五块的一个排列，坏数据回落默认）
 * - collapsed：各块是否折叠
 */

export interface NoteLayout {
  order: NoteKind[];
  collapsed: Partial<Record<NoteKind, boolean>>;
}

const KEY = "paper-field.note-layout";

export const DEFAULT_NOTE_LAYOUT: NoteLayout = {
  order: [...NOTE_DISPLAY_ORDER],
  collapsed: {},
};

function isPermutationOfKinds(order: unknown): order is NoteKind[] {
  return (
    Array.isArray(order) &&
    order.length === NOTE_KINDS.length &&
    NOTE_KINDS.every((kind) => order.includes(kind))
  );
}

/** 读取本机笔记布局；缺失 / 坏数据（缺块、多块、重复）回落默认顺序与全展开。 */
export function loadNoteLayout(): NoteLayout {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    if (!raw) return { order: [...DEFAULT_NOTE_LAYOUT.order], collapsed: {} };
    const value = JSON.parse(raw) as Partial<NoteLayout> | null;
    if (!value || typeof value !== "object") return { ...DEFAULT_NOTE_LAYOUT };
    const order = isPermutationOfKinds(value.order) ? [...value.order] : [...DEFAULT_NOTE_LAYOUT.order];
    const collapsed: Partial<Record<NoteKind, boolean>> = {};
    for (const kind of NOTE_KINDS) {
      if (value.collapsed && typeof value.collapsed[kind] === "boolean") collapsed[kind] = value.collapsed[kind];
    }
    return { order, collapsed };
  } catch {
    return { ...DEFAULT_NOTE_LAYOUT };
  }
}

/** 保存布局；存不下（隐私模式等）时本会话仍生效。 */
export function saveNoteLayout(layout: NoteLayout): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // 忽略：内存中的布局不受影响。
  }
}

/** 把某块上移 / 下移一位（到头不动），返回新顺序。 */
export function moveNoteKind(order: NoteKind[], kind: NoteKind, direction: "up" | "down"): NoteKind[] {
  const index = order.indexOf(kind);
  if (index < 0) return order;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
