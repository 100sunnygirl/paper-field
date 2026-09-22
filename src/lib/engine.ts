import { PAPER_MIGRATIONS, SCHEMA_STATEMENTS } from "./schema";
import { isTauri } from "./util";
import type initSqlJsType from "sql.js";

export interface SqlEngine {
  execute(sql: string, params?: unknown[]): Promise<void>;
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

class SqlJsEngine implements SqlEngine {
  private persistTimer: number | null = null;

  constructor(private db: import("sql.js").Database) {}

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    this.db.run(sql, params as (string | number | null | Uint8Array)[]);
    this.schedulePersist();
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
        console.error("Failed to persist local SQLite", err);
      });
    }, 80);
  }
}

class TauriEngine implements SqlEngine {
  constructor(private db: import("@tauri-apps/plugin-sql").default) {}

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.db.execute(sql, params);
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.select<T[]>(sql, params);
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

async function persistSqlJs(bytes: Uint8Array): Promise<void> {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
  });
}

async function applySchema(engine: SqlEngine): Promise<void> {
  await engine.execute("PRAGMA foreign_keys = ON");
  for (const statement of SCHEMA_STATEMENTS) {
    await engine.execute(statement);
  }
  for (const statement of PAPER_MIGRATIONS) {
    try {
      await engine.execute(statement);
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (message.includes("duplicate column")) continue;
      throw err;
    }
  }
  await engine.execute("CREATE INDEX IF NOT EXISTS idx_papers_pdf_path ON papers(pdf_path)");
}

let singleton: Promise<SqlEngine> | null = null;

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
