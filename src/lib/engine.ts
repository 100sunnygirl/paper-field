import { runMigrations, SCHEMA_VERSION, tableExists, userVersion } from "./schema";
import { isTauri } from "./util";
import type initSqlJsType from "sql.js";

/** 一步写入的受影响行数期望：恰好 1 行 / 至少 1 行 / 不检查。 */
export type Expect = "one" | "some" | "any";

export interface BatchStep {
  sql: string;
  params?: unknown[];
  /** 默认 "any"。条件写入用它声明前提：前提被别人改掉时受影响行数不符，整批回滚。 */
  expect?: Expect;
}

/** batch 中某一步的受影响行数不符合 expect：整批已回滚，调用方决定重读重试还是提示。 */
export class ConflictError extends Error {
  constructor(readonly step: number) {
    super(`写入冲突（第 ${step + 1} 步）`);
    this.name = "ConflictError";
  }
}

export interface SqlEngine {
  /** 单条写入，自动提交；返回真实受影响行数。 */
  execute(sql: string, params?: unknown[]): Promise<number>;
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** 全部步骤在一个事务里执行；任一步不满足 expect 就整体回滚并抛 ConflictError。 */
  batch(steps: BatchStep[]): Promise<number[]>;
  /** Consistent bytes of the current database, used to copy it aside before migrating. */
  snapshot?(): Uint8Array;
  close?(): Promise<void>;
}

export function expectMet(expect: Expect | undefined, rows: number): boolean {
  if (expect === "one") return rows === 1;
  if (expect === "some") return rows >= 1;
  return true;
}

// SQLite 落盘失败的单出口：App 挂载后注入 handler 走 toast 通知
// （经 toasts.notify 收口自动入运行日志）；未注入时退回 console.error 兜底。
// 两条路径互斥，不得并存（也不在 engine 内直接写日志，避免第二套通道）。
let onPersistFailure: ((message: string) => void) | null = null;

export function setPersistFailureHandler(handler: ((message: string) => void) | null): void {
  onPersistFailure = handler;
}

type SqlJsParams = (string | number | null | Uint8Array)[];

/**
 * sql.js 引擎（浏览器预览与测试共用）。sql.js 是单连接同步 API，batch 在一次同步调用里
 * BEGIN … COMMIT，期间不会有其他调用插进来。`persist` 关掉时不写 IndexedDB（测试用）。
 */
export class SqlJsEngine implements SqlEngine {
  private persistTimer: number | null = null;

  constructor(
    private db: import("sql.js").Database,
    private options: { persist: boolean } = { persist: true },
  ) {}

  async execute(sql: string, params: unknown[] = []): Promise<number> {
    this.db.run(sql, params as SqlJsParams);
    const changed = this.db.getRowsModified();
    this.schedulePersist();
    return changed;
  }

  async batch(steps: BatchStep[]): Promise<number[]> {
    const out: number[] = [];
    this.db.run("BEGIN IMMEDIATE");
    try {
      steps.forEach((step, index) => {
        this.db.run(step.sql, (step.params ?? []) as SqlJsParams);
        // DDL 不改 changes()：只对 DML 声明 expect。
        const rows = /^\s*(insert|update|delete|replace)\b/i.test(step.sql) ? this.db.getRowsModified() : 0;
        if (!expectMet(step.expect, rows)) throw new ConflictError(index);
        out.push(rows);
      });
      this.db.run("COMMIT");
    } catch (err) {
      this.db.run("ROLLBACK");
      throw err;
    }
    this.schedulePersist();
    return out;
  }

  snapshot(): Uint8Array {
    return this.db.export();
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as SqlJsParams);
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  exportBytes(): Uint8Array {
    return this.db.export();
  }

  private schedulePersist() {
    if (!this.options.persist) return;
    if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => {
      persistSqlJs(this.db.export()).catch((err) => {
        if (onPersistFailure) {
          onPersistFailure(`本地 SQLite 持久化失败：${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        console.error("Failed to persist local SQLite", err);
      });
    }, 80);
  }
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function isConflict(err: unknown): err is { kind: "conflict"; step: number } {
  return Boolean(err) && typeof err === "object" && (err as { kind?: unknown }).kind === "conflict";
}

function dbErrorText(err: unknown): unknown {
  if (err && typeof err === "object" && (err as { kind?: unknown }).kind === "sql") {
    return new Error(String((err as { message?: unknown }).message ?? "数据库错误"));
  }
  return err;
}

/**
 * 桌面端：所有读写经 Rust 的 db_* 命令（src-tauri/src/db.rs）。读走只读连接池，
 * 写走单连接写池，batch 在一个事务里执行；渲染进程不再持有任何 SQL 插件权限。
 */
export class TauriEngine implements SqlEngine {
  constructor(private invoke: Invoke) {}

  async execute(sql: string, params: unknown[] = []): Promise<number> {
    try {
      return Number(await this.invoke<number>("db_execute", { sql, params }));
    } catch (err) {
      throw dbErrorText(err);
    }
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    try {
      return await this.invoke<T[]>("db_select", { sql, params });
    } catch (err) {
      throw dbErrorText(err);
    }
  }

  async batch(steps: BatchStep[]): Promise<number[]> {
    try {
      const rows = await this.invoke<number[]>("db_batch", {
        steps: steps.map((step) => ({ sql: step.sql, params: step.params ?? [], expect: step.expect ?? "any" })),
      });
      return rows.map(Number);
    } catch (err) {
      if (isConflict(err)) throw new ConflictError(err.step);
      throw dbErrorText(err);
    }
  }

  async close(): Promise<void> {
    await this.invoke("db_close");
  }
}

const IDB_NAME = "paper-field";
const IDB_STORE = "sqlite";
const IDB_KEY = "paper-field.db";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadSqlJsBytes(): Promise<Uint8Array | null> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => {
      const value = req.result;
      resolve(value instanceof Uint8Array ? value : null);
    };
    req.onerror = () => reject(req.error);
  });
}

async function persistSqlJs(bytes: Uint8Array, key = IDB_KEY): Promise<void> {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(IDB_STORE).put(bytes, key);
  });
}

let lastPremigrationBackup: Uint8Array | null = null;

/** Bytes copied aside before the most recent migration in this process, if the engine could snapshot. */
export function premigrationBackup(): Uint8Array | null {
  return lastPremigrationBackup;
}

export function clearPremigrationBackup(): void {
  lastPremigrationBackup = null;
}

async function backupBeforeMigration(engine: SqlEngine): Promise<void> {
  if (engine.snapshot) {
    lastPremigrationBackup = engine.snapshot();
    if (!isTauri() && typeof indexedDB !== "undefined") {
      await persistSqlJs(lastPremigrationBackup, "paper-field.db.premigrate").catch((err) => {
        console.error("Failed to persist pre-migration database copy", err);
      });
    }
  }
  if (!isTauri()) return;
  await engine.execute("PRAGMA wal_checkpoint(FULL)");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("backup_database_file");
}

export async function applySchema(engine: SqlEngine): Promise<void> {
  await engine.execute("PRAGMA foreign_keys = ON");
  const current = await userVersion(engine);
  if (current >= SCHEMA_VERSION) return;
  if (await tableExists(engine, "papers")) {
    await backupBeforeMigration(engine);
  }
  await runMigrations(engine, current);
}

export type RestoreStatus =
  | { kind: "none" }
  | { kind: "restored"; pre: string; summary: { papers: number; pdfs: number } | null }
  | { kind: "rolledBack"; pre: string }
  | { kind: "pendingConfirm" }
  | { kind: "stuck"; pre: string; dbAvailable: boolean };

export class RestoreStuckError extends Error {
  constructor(readonly pre: string) {
    super(`上一次恢复没有完成，为保护数据暂不打开文库。原数据保存在 ${pre || "应用数据目录"}。`);
    this.name = "RestoreStuckError";
  }
}

/** Startup restore outcome, for the UI to surface (rolled back, pending confirm, stuck). */
export let lastRestoreStatus: RestoreStatus = { kind: "none" };

let singleton: Promise<SqlEngine> | null = null;

export async function resetEngine(): Promise<void> {
  const pending = singleton;
  singleton = null;
  if (!pending) return;
  try {
    const engine = await pending;
    await engine.close?.();
  } catch {
    singleton = null;
  }
}

export function getEngine(): Promise<SqlEngine> {
  if (!singleton) {
    singleton = openEngine().catch((error) => {
      singleton = null;
      throw error;
    });
  }
  return singleton;
}

function loadClassicScript(src: string): Promise<void> {
  const marker = "paper-field-sqljs";
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-pf="${marker}"]`);
    if (existing && typeof window.initSqlJs === "function") {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.pf = marker;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function loadBrowserSql(): Promise<typeof initSqlJsType> {
  await loadClassicScript("/vendor/sql-wasm.js");
  const init = window.initSqlJs;
  if (typeof init !== "function") {
    throw new Error("sql.js classic script did not expose initSqlJs");
  }
  return init;
}

async function openEngine(): Promise<SqlEngine> {
  if (isTauri()) {
    // Must run before the first db_* command: opening the pool creates an empty database when the file is missing.
    const { invoke } = await import("@tauri-apps/api/core");
    const status = await invoke<RestoreStatus>("restore_status");
    // Any stuck restore blocks: a database file may exist but be half-swapped.
    if (status.kind === "stuck") {
      throw new RestoreStuckError(status.pre);
    }
    lastRestoreStatus = status;
    const engine = new TauriEngine(invoke as Invoke);
    await applySchema(engine);
    return engine;
  }

  const initSqlJs = await loadBrowserSql();
  const SQL = await initSqlJs({ locateFile: (file) => `/vendor/${file}` });
  const existing = await loadSqlJsBytes();
  const db = existing ? new SQL.Database(existing) : new SQL.Database();
  const engine = new SqlJsEngine(db);
  await applySchema(engine);
  return engine;
}
