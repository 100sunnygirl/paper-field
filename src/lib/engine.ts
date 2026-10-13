import { runMigrations, SCHEMA_VERSION, tableExists, userVersion } from "./schema";
import { isTauri } from "./util";
import type initSqlJsType from "sql.js";

export interface SqlEngine {
  execute(sql: string, params?: unknown[]): Promise<number>;
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Consistent bytes of the current database, used to copy it aside before migrating. */
  snapshot?(): Uint8Array;
  close?(): Promise<void>;
}

// SQLite 落盘失败的单出口：App 挂载后注入 handler 走 toast 通知
// （经 toasts.notify 收口自动入运行日志）；未注入时退回 console.error 兜底。
// 两条路径互斥，不得并存（也不在 engine 内直接写日志，避免第二套通道）。
let onPersistFailure: ((message: string) => void) | null = null;

export function setPersistFailureHandler(handler: ((message: string) => void) | null): void {
  onPersistFailure = handler;
}

class SqlJsEngine implements SqlEngine {
  private persistTimer: number | null = null;

  constructor(private db: import("sql.js").Database) {}

  async execute(sql: string, params: unknown[] = []): Promise<number> {
    this.db.run(sql, params as (string | number | null | Uint8Array)[]);
    const changed = this.db.getRowsModified();
    this.schedulePersist();
    return changed;
  }

  snapshot(): Uint8Array {
    return this.db.export();
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as (string | number | null | Uint8Array)[]);
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

class TauriEngine implements SqlEngine {
  constructor(private db: import("@tauri-apps/plugin-sql").default) {}

  async execute(sql: string, params: unknown[] = []): Promise<number> {
    const changed = await this.db.execute(sql, params);
    return typeof changed === "number" ? changed : 0;
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.select<T[]>(sql, params);
  }

  async close(): Promise<void> {
    await this.db.close();
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
    const Database = (await import("@tauri-apps/plugin-sql")).default;
    const db = await Database.load("sqlite:paper-field.db");
    const engine = new TauriEngine(db);
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
