/**
 * 资料栏区块的折叠偏好（本机 localStorage 记忆）：
 * links（资料与链接）/ toc（本页目录）/ ai（AI 助手）。
 * 阅读状态与状态卡不参与折叠——它们是常驻信息。
 * 资料栏在右栏与窄屏抽屉里可能同时挂两份实例，用外部store保持同步。
 */

export type ContextBlockId = "links" | "toc" | "ai";

export const CONTEXT_BLOCK_IDS: ContextBlockId[] = ["links", "toc", "ai"];

export interface ContextFoldState {
  folded: Partial<Record<ContextBlockId, boolean>>;
}

const KEY = "paper-field.context-fold";

function normalize(value: unknown): ContextFoldState {
  const folded: Partial<Record<ContextBlockId, boolean>> = {};
  if (value && typeof value === "object") {
    for (const id of CONTEXT_BLOCK_IDS) {
      const flag = (value as Record<string, unknown>)[id];
      if (typeof flag === "boolean") folded[id] = flag;
    }
  }
  return { folded };
}

function load(): ContextFoldState {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    return raw ? normalize(JSON.parse(raw) as unknown) : { folded: {} };
  } catch {
    return { folded: {} };
  }
}

let state: ContextFoldState = load();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** useSyncExternalStore 的订阅入口。 */
export function subscribeContextFold(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** useSyncExternalStore 的快照（引用稳定：只在变更时换新对象）。 */
export function getContextFold(): ContextFoldState {
  return state;
}

/** 展开 / 折叠一个区块：更新内存快照并写穿到 localStorage。 */
export function setContextFolded(id: ContextBlockId, folded: boolean): void {
  state = { folded: { ...state.folded, [id]: folded } };
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(state.folded));
  } catch {
    // 存不下（隐私模式等）：本会话仍生效。
  }
  emit();
}
