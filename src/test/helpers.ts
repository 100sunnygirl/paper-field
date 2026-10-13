import initSqlJs from "sql.js";
import { applySchema, type SqlEngine } from "../lib/engine";

/**
 * node 环境下的内存引擎：sql.js 的 Node 构建自动经 fs 定位 wasm，
 * 不走 engine.ts 的浏览器 script 注入路径，也不触碰 IndexedDB。
 * 建表必须复用生产 applySchema（SCHEMA_STATEMENTS + PAPER_MIGRATIONS），
 * 保证测试库结构与真实库完全一致（含容错迁移与 idx_papers_pdf_path 索引）。
 */
export async function makeTestEngine(): Promise<TestEngineHandle> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const engine: SqlEngine = {
    async execute(sql: string, params: unknown[] = []): Promise<number> {
      db.run(sql, params as (string | number | null | Uint8Array)[]);
      return db.getRowsModified();
    },
    snapshot(): Uint8Array {
      return db.export();
    },
    async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const stmt = db.prepare(sql);
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
    },
  };
  await applySchema(engine);
  return {
    engine,
    close: () => db.close(),
  };
}

export interface TestEngineHandle {
  engine: SqlEngine;
  close: () => void;
}
