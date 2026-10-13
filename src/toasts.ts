// 通知（toast）层：独立于 useField 的堆叠 store，最高同时显示 MAX_TOASTS 条。
// 各条独立计时自动消退（dismiss:auto）、可手动关闭（dismiss:manual）、
// 同 (tone,text) 去重只刷新停留计时（refresh）、超上限逐出最旧非 error（evict）。
//
// 【日志唯一收口】（评审裁定）：通知生命周期事件经 bindToastLog 注入的 sink
// 送往日志系统（main.tsx 是产品侧唯一注入点），本模块不直接依赖 logger——
// 未注入时静默，不散落 console。store.ts 的 setFlash 在写 flash 镜像的同时
// 桥接到 notify，全部既有调用点零迁移即被收口覆盖；emit / dismiss / refresh /
// evict 只发生在本层，收口在这里不丢事件。
import { nowIso } from "./lib/util";

export type ToastTone = "ok" | "warn" | "error";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  text: string;
  /** 入列时间（ISO）。 */
  createdAt: string;
  /** 本条覆盖自动消退时长（毫秒）；0 = 不自动消退；缺省按 tone 取 TOAST_DURATION。 */
  durationMs?: number;
  /** 来源标记（如 "mineru"），桥接 setFlash 不填、新调用方可填。 */
  scope?: string;
  /** 停留计时的重置次数：去重刷新时 +1，UI 据此重播倒计时条。 */
  rev?: number;
  action?: ToastAction;
}

/** 各级别默认停留时长（毫秒）：错误类更久，与原 flash 自动消失节奏一致。 */
export const TOAST_DURATION: Readonly<Record<ToastTone, number>> = {
  ok: 4200,
  warn: 4200,
  error: 8000,
};

/** 堆叠上限：超出时逐出最旧一条非 error（全为 error 时才逐出最旧）。 */
export const MAX_TOASTS = 4;

/** 通知生命周期事件；级别映射（ok→info / warn→warn / error→error）由注入侧负责。 */
export interface ToastLogEvent {
  action: "emit" | "dismiss" | "refresh" | "evict";
  id: number;
  tone: ToastTone;
  text: string;
  scope?: string;
  /** 仅 dismiss：auto = 停留到期自动消退，manual = 手动或编程式关闭。 */
  reason?: "auto" | "manual";
  /** 事件时间（ISO）。 */
  at: string;
}

export type ToastSink = (event: ToastLogEvent) => void;

let sink: ToastSink | null = null;

/** 注入 / 摘除日志 sink；传 null 摘除。未注入时事件静默丢弃（无本地缓冲）。 */
export function bindToastLog(next: ToastSink | null): void {
  sink = next;
}

let items: ToastItem[] = [];
let version = 0;
let nextId = 1;
const listeners = new Set<() => void>();

/** id → 计时状态：暂停时冻结剩余时长，恢复时接续（hover 暂停不重置全时长）。 */
const timers = new Map<number, { handle: number; remaining: number; paused: boolean; armedAt: number }>();

/** 订阅堆叠变化；返回退订函数。 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** useSyncExternalStore 的 getSnapshot：必须返回版本号原始值。 */
export function getVersion(): number {
  return version;
}

/** 读取当前堆叠副本（旧→新）。 */
export function getToasts(): ToastItem[] {
  return [...items];
}

function bump(): void {
  version += 1;
  listeners.forEach((listener) => listener());
}

function sinkEvent(
  action: ToastLogEvent["action"],
  item: Pick<ToastItem, "id" | "tone" | "text" | "scope">,
  reason?: ToastLogEvent["reason"],
): void {
  sink?.({
    action,
    id: item.id,
    tone: item.tone,
    text: item.text,
    ...(item.scope ? { scope: item.scope } : {}),
    ...(reason ? { reason } : {}),
    at: nowIso(),
  });
}

function clearTimer(id: number): void {
  const state = timers.get(id);
  if (state !== undefined) {
    window.clearTimeout(state.handle);
    timers.delete(id);
  }
}

function armTimer(id: number, duration: number): void {
  clearTimer(id);
  if (duration <= 0) return; // 0 = 不自动消退
  const handle = window.setTimeout(() => {
    timers.delete(id);
    dismiss(id, "auto");
  }, duration);
  timers.set(id, { handle, remaining: duration, paused: false, armedAt: Date.now() });
}

/** 悬停 / 聚焦时暂停自动消退：冻结剩余时长。对不自动消退或已暂停的条目无操作。 */
export function pause(id: number): void {
  const state = timers.get(id);
  if (state === undefined || state.paused) return;
  window.clearTimeout(state.handle);
  state.remaining = Math.max(0, state.remaining - (Date.now() - state.armedAt));
  state.paused = true;
}

/** 离开 / 失焦后接续剩余时长。 */
export function resume(id: number): void {
  const state = timers.get(id);
  if (state === undefined || !state.paused) return;
  state.handle = window.setTimeout(() => {
    timers.delete(id);
    dismiss(id, "auto");
  }, state.remaining);
  state.paused = false;
  state.armedAt = Date.now();
}

/** 超上限逐出：错误信息尽量保留——优先逐出最旧的非 error，全为 error 才逐出最旧。 */
function evictOldest(): void {
  const victim = items.find((item) => item.tone !== "error") ?? items[0];
  if (!victim) return;
  items = items.filter((item) => item.id !== victim.id);
  clearTimer(victim.id);
  sinkEvent("evict", victim);
}

export interface NotifyOptions {
  /** 覆盖本条自动消退时长（毫秒），0 = 不自动消退。 */
  durationMs?: number;
  /** 来源标记，随日志事件透出。 */
  scope?: string;
  /** 一个可点的操作按钮（如「重试」）；带操作的通知不自动消退，免得用户来不及点。 */
  action?: ToastAction;
}

export interface ToastAction {
  label: string;
  run: () => void;
}

/** 发出一条通知；同 (tone,text) 已在场时只刷新停留计时（不重复入列、不重复 emit）。 */
export function notify(tone: ToastTone, text: string, options?: NotifyOptions): void {
  if (options?.action && options.durationMs === undefined) options = { ...options, durationMs: 0 };
  const existing = items.find((item) => item.tone === tone && item.text === text);
  if (existing) {
    armTimer(existing.id, options?.durationMs ?? existing.durationMs ?? TOAST_DURATION[tone]);
    // A refreshed toast takes the newest action (e.g. retry with the latest failed list).
    items = items.map((item) =>
      item.id === existing.id
        ? { ...item, rev: (item.rev ?? 0) + 1, ...(options?.action ? { action: options.action } : {}) }
        : item,
    );
    bump();
    sinkEvent("refresh", { ...existing, scope: options?.scope ?? existing.scope });
    return;
  }
  const item: ToastItem = {
    id: nextId,
    tone,
    text,
    createdAt: nowIso(),
    ...(options?.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
    ...(options?.scope ? { scope: options.scope } : {}),
    ...(options?.action ? { action: options.action } : {}),
  };
  nextId += 1;
  items = [...items, item];
  if (items.length > MAX_TOASTS) evictOldest();
  armTimer(item.id, options?.durationMs ?? TOAST_DURATION[tone]);
  bump();
  sinkEvent("emit", item);
}

/** 关闭一条通知；reason 区分自动消退（auto）与手动 / 编程式关闭（manual）。 */
export function dismiss(id: number, reason: ToastLogEvent["reason"] = "manual"): void {
  const target = items.find((item) => item.id === id);
  if (!target) return;
  items = items.filter((item) => item.id !== id);
  clearTimer(id);
  bump();
  sinkEvent("dismiss", target, reason);
}

/** 清空整个堆叠（setFlash(null) 桥接用）：逐条记 dismiss 事件。 */
export function dismissAll(reason: ToastLogEvent["reason"] = "manual"): void {
  for (const item of getToasts()) dismiss(item.id, reason);
}
