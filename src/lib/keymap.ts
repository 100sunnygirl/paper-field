import { shortcut } from "./util";

/**
 * 可自定义的全局快捷键（方向键 / Esc 固定，不做绑定编辑）。
 * 默认键位与历史行为完全一致（⌘/Ctrl + N/R/K/J）；自定义只存本机 localStorage。
 */
export type KeymapAction = "addPaper" | "markRead" | "search" | "jobsPanel";

export interface KeyBinding {
  /** 单个小写字母或数字。 */
  key: string;
  /** true = ⌘/Ctrl 组合。当前只接受组合键（纯字母会干扰输入）。 */
  meta: boolean;
}

export const KEYMAP_ACTIONS: Array<{ id: KeymapAction; label: string }> = [
  { id: "addPaper", label: "添加论文（导入 PDF / 手动录入）" },
  { id: "markRead", label: "标记已读" },
  { id: "search", label: "搜索" },
  { id: "jobsPanel", label: "作业面板" },
];

export const DEFAULT_KEYMAP: Record<KeymapAction, KeyBinding> = {
  addPaper: { key: "n", meta: true },
  markRead: { key: "r", meta: true },
  search: { key: "k", meta: true },
  jobsPanel: { key: "j", meta: true },
};

const KEYMAP_KEY = "paper-field.keymap";
const KEY_PATTERN = /^[a-z0-9]$/;

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().slice(0, 1);
}

/** 读取本机自定义键位；缺失或坏数据回落默认。 */
export function loadKeymap(): Record<KeymapAction, KeyBinding> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEYMAP_KEY);
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    if (!value || typeof value !== "object") return { ...DEFAULT_KEYMAP };
    const merged: Record<KeymapAction, KeyBinding> = { ...DEFAULT_KEYMAP };
    for (const action of Object.keys(DEFAULT_KEYMAP) as KeymapAction[]) {
      const item = (value as Record<string, unknown>)[action] as Partial<KeyBinding> | undefined;
      if (
        item &&
        typeof item === "object" &&
        typeof item.key === "string" &&
        typeof item.meta === "boolean" &&
        item.meta === true &&
        KEY_PATTERN.test(normalizeKey(item.key))
      ) {
        merged[action] = { key: normalizeKey(item.key), meta: true };
      }
    }
    return merged;
  } catch {
    return { ...DEFAULT_KEYMAP };
  }
}

/** 模块级当前键位：保存后立即生效（App 的键盘处理每次事件实时读取，无需重挂载）。 */
let current: Record<KeymapAction, KeyBinding> = loadKeymap();

export function currentKeymap(): Record<KeymapAction, KeyBinding> {
  return current;
}

export interface SaveBindingResult {
  ok: boolean;
  /** 冲突时指出占用该组合的动作。 */
  conflict?: KeymapAction;
  /** 输入不合法时的原因。 */
  reason?: string;
}

/** 保存一个自定义键位；与其他动作冲突或键位不合法时拒绝并说明原因。 */
export function saveKeyBinding(action: KeymapAction, binding: KeyBinding): SaveBindingResult {
  const key = normalizeKey(binding.key);
  if (!binding.meta) return { ok: false, reason: "请按住 ⌘/Ctrl 组合键，纯字母键会干扰正常输入。" };
  if (!KEY_PATTERN.test(key)) return { ok: false, reason: "只支持字母或数字键。" };
  const conflict = bindingConflicts(current, action, { key, meta: true });
  if (conflict) return { ok: false, conflict };
  current = { ...current, [action]: { key, meta: true } };
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEYMAP_KEY, JSON.stringify(current));
  } catch {
    // 写不进（隐私模式等）：本会话仍生效，重启回落默认。
  }
  return { ok: true };
}

/** 恢复全部默认键位。 */
export function resetKeymap(): void {
  current = { ...DEFAULT_KEYMAP };
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(KEYMAP_KEY);
  } catch {
    // 忽略：本会话已恢复默认。
  }
}

/** 同一组合已被其他动作占用时返回那个动作。 */
export function bindingConflicts(
  map: Record<KeymapAction, KeyBinding>,
  action: KeymapAction,
  binding: KeyBinding,
): KeymapAction | null {
  const key = normalizeKey(binding.key);
  for (const other of Object.keys(map) as KeymapAction[]) {
    if (other === action) continue;
    if (map[other].key === key && map[other].meta === binding.meta) return other;
  }
  return null;
}

/** 键盘事件是否命中键位（⌘ 与 Ctrl 等价）。 */
export function eventMatchesBinding(
  event: { metaKey: boolean; ctrlKey: boolean; key: string },
  binding: KeyBinding,
): boolean {
  const meta = event.metaKey || event.ctrlKey;
  return meta === binding.meta && event.key.toLowerCase() === binding.key;
}

/** 展示用键位文案，如「⌘ N」。 */
export function bindingLabel(binding: KeyBinding): string {
  const key = binding.key.toUpperCase();
  return binding.meta ? shortcut(key) : key;
}
