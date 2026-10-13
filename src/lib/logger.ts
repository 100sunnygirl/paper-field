// 运行日志：全应用唯一的日志模块。
// - 内存环形缓冲（最新在尾）+ 版本号订阅（useSyncExternalStore 的 getSnapshot
//   必须返回版本号原始值，返回新数组会触发无限重渲染）；
// - 控制台镜像按级别映射 console.debug/log/warn/error，带 [scope] 前缀；
//   debug 仅在 DEV 镜像（缓冲始终保留）；
// - Tauri 桌面端经 plugin-store 落盘 app-log.json（3s 尾沿防抖，只写 ≥info
//   的最近 200 条）；文件名与 llm-settings.json / mineru-settings.json 永久错开
//   （0.2.6 事故教训：plugin-store 与设置文件同名同目录会互相覆盖）；
// - 非 Tauri（浏览器预览 / jsdom 测试）只缓冲 + console，零动态 import、零 IPC；
// - 落盘失败静默降级为仅内存缓冲，并只写一条 warn 条目（防自激励循环）。
// 约定：message/detail 不得包含 API Key / Token 等机密（现有 flash 文案只回显 hasKey）。
import { redactSecrets } from "./redact";
import { isTauri, nowIso } from "./util";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogScope = "app" | "store" | "llm" | "mineru" | "engine" | "ui";

export interface LogEntry {
  seq: number;
  /** ISO 时间戳。 */
  ts: string;
  level: LogLevel;
  scope: LogScope;
  message: string;
  /** 错误文案（Error 取 message，其余 String 化）；不存堆栈与机密。 */
  detail?: string;
}

/** 内存环形缓冲容量（命名常量）。 */
export const LOG_BUFFER_LIMIT = 500;
/** 落盘条数上限：只写 ≥info，避免 debug 噪音膨胀文件。 */
export const LOG_PERSIST_LIMIT = 200;
/** 落盘尾沿防抖：高频写入合并为一次 save。 */
const PERSIST_DEBOUNCE_MS = 3000;
const STORE_FILE = "app-log.json";
const STORE_KEY = "entries";

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const SCOPES: readonly LogScope[] = ["app", "store", "llm", "mineru", "engine", "ui"];

let buffer: LogEntry[] = [];
let version = 0;
let seq = 0;
const listeners = new Set<() => void>();

/** 订阅缓冲变化；返回退订函数。 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** useSyncExternalStore 的 getSnapshot：必须返回版本号原始值。 */
export function getVersion(): number {
  return version;
}

/** 读取当前缓冲副本（时间正序，最新在尾）；UI 自行反转与过滤。 */
export function getEntries(): LogEntry[] {
  return [...buffer];
}

function push(level: LogLevel, scope: LogScope, message: string, detail?: string): void {
  const entry: LogEntry = {
    seq: (seq += 1),
    ts: nowIso(),
    level,
    scope,
    message: redactSecrets(message),
    ...(detail === undefined ? {} : { detail: redactSecrets(detail) }),
  };
  buffer.push(entry);
  if (buffer.length > LOG_BUFFER_LIMIT) buffer.splice(0, buffer.length - LOG_BUFFER_LIMIT);
  version += 1;
  listeners.forEach((listener) => listener());
  mirror(entry);
  schedulePersist();
}

export const log = {
  debug(scope: LogScope, message: string, detail?: unknown): void {
    push("debug", scope, message, detailText(detail));
  },
  info(scope: LogScope, message: string, detail?: unknown): void {
    push("info", scope, message, detailText(detail));
  },
  warn(scope: LogScope, message: string, detail?: unknown): void {
    push("warn", scope, message, detailText(detail));
  },
  error(scope: LogScope, message: string, detail?: unknown): void {
    push("error", scope, message, detailText(detail));
  },
};

function detailText(detail: unknown): string | undefined {
  if (detail === undefined) return undefined;
  const text = detail instanceof Error ? detail.message : String(detail);
  return redactSecrets(text);
}

function mirror(entry: LogEntry): void {
  // debug 只在开发构建镜像到控制台；缓冲始终保留。
  if (entry.level === "debug" && !import.meta.env.DEV) return;
  const line = `[${entry.scope}] ${entry.message}${entry.detail ? `：${entry.detail}` : ""}`;
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else if (entry.level === "info") console.log(line);
  else console.debug(line);
}

// ---------- Tauri 落盘（仅 isTauri() 时才动态 import plugin-store） ----------

let storePromise: Promise<import("@tauri-apps/plugin-store").Store> | null = null;
let persistTimer: number | null = null;
/** 落盘故障标记：置位后彻底降级为仅内存，不再重试（防自激励循环）。 */
let persistBroken = false;
let persistWarned = false;

function ensureStore(): Promise<import("@tauri-apps/plugin-store").Store> {
  if (!storePromise) {
    storePromise = import("@tauri-apps/plugin-store").then(({ load }) =>
      // autoSave 关闭：统一由下面的显式 save() 控制落盘时机。
      load(STORE_FILE, { autoSave: false }),
    );
  }
  return storePromise;
}

async function flush(): Promise<void> {
  const store = await ensureStore();
  const entries = buffer.filter((entry) => entry.level !== "debug").slice(-LOG_PERSIST_LIMIT);
  await store.set(STORE_KEY, entries);
  await store.save();
}

function schedulePersist(): void {
  if (!isTauri() || persistBroken) return;
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    flush().catch(() => {
      persistBroken = true;
      if (persistWarned) return;
      persistWarned = true;
      // 直接走 push 而非 log.warn：此时已 persistBroken，不会再次调度落盘。
      push("warn", "app", "运行日志落盘失败，本次会话的日志只保留在内存中。");
    });
  }, PERSIST_DEBOUNCE_MS);
}

/** 清空纪元：clear() 自增；在途回读落地时校验，纪元不符（期间发生过清空）则丢弃回读数据，防止已清空的日志被复活。 */
let clearEpoch = 0;

/** 清空缓冲并清除落盘键；非 Tauri / 已降级时仅清内存。 */
export async function clear(): Promise<void> {
  clearEpoch += 1;
  buffer = [];
  version += 1;
  listeners.forEach((listener) => listener());
  if (!isTauri() || persistBroken) return;
  try {
    const store = await ensureStore();
    await store.clear();
    await store.save();
  } catch {
    persistBroken = true;
  }
}

function isValidEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<LogEntry>;
  return (
    typeof entry.seq === "number" &&
    typeof entry.ts === "string" &&
    LEVELS.includes(entry.level as LogLevel) &&
    SCOPES.includes(entry.scope as LogScope) &&
    typeof entry.message === "string"
  );
}

// 启动回读：上次会话落盘的尾部入本次缓冲头，崩溃后可回溯。
// 仅 Tauri 执行；回读失败按落盘故障处理（降级 + 一次性 warn），不阻断应用。
function bootstrap(): void {
  if (!isTauri()) return;
  const epoch = clearEpoch;
  ensureStore()
    .then((store) => store.get<unknown>(STORE_KEY))
    .then((value) => {
      // 竞态守卫：回读在途期间若发生过 clear()（纪元已变），回读到的旧数据
      // 已被用户明确清除，落地合并等于复活已清空的日志——直接丢弃。
      if (epoch !== clearEpoch) return;
      if (!Array.isArray(value)) return;
      const restored = value.filter(isValidEntry).slice(-LOG_BUFFER_LIMIT);
      if (!restored.length) return;
      // IPC 完成前的启动窗口里可能已有本会话条目写入：合并而非替换，
      // 否则早期条目被静默丢弃。同时把已有条目重新编号到回读最大 seq
      // 之后——否则本次会话 seq 从 1 重数会与回读条目撞号（LogPanel 用
      // seq 作 React key），且破坏"seq 单调递增"的读取方约定。
      const maxRestored = restored.reduce((max, entry) => Math.max(max, entry.seq), 0);
      const merged = buffer.map((entry, index) => ({ ...entry, seq: maxRestored + index + 1 }));
      buffer = [...restored, ...merged].slice(-LOG_BUFFER_LIMIT);
      seq = Math.max(seq, maxRestored + merged.length);
      version += 1;
      listeners.forEach((listener) => listener());
    })
    .catch(() => {
      persistBroken = true;
      if (persistWarned) return;
      persistWarned = true;
      push("warn", "app", "运行日志读取失败，本次会话的日志只保留在内存中。");
    });
}

bootstrap();
