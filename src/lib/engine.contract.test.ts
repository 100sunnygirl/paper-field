import initSqlJs from "sql.js";
import { beforeEach, describe, expect, it } from "vitest";
import Database from "@tauri-apps/plugin-sql";
import { TauriEngine, type SqlEngine } from "./engine";
import { makeTestEngine } from "../test/helpers";

// 用真实的 plugin-sql JS 封装 + 假 IPC（背后是 sql.js），让 TauriEngine 走生产时的返回结构。
async function makeTauriEngine(): Promise<SqlEngine> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  // plugin-sql 从 node_modules 直接引用真实的 @tauri-apps/api/core，它最终调用 __TAURI_INTERNALS__.invoke。
  const fakeInvoke = async (cmd: string, args?: unknown) => {
    const { query, values } = (args ?? {}) as { query?: string; values?: unknown[] };
    if (cmd === "plugin:sql|load") return "sqlite:test.db";
    if (cmd === "plugin:sql|execute") {
      db.run(query!, values as (string | number | null)[]);
      return [db.getRowsModified(), 0];
    }
    if (cmd === "plugin:sql|select") {
      const stmt = db.prepare(query!);
      stmt.bind(values as (string | number | null)[]);
      const rows: unknown[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    }
    throw new Error(`unexpected IPC ${cmd}`);
  };
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: fakeInvoke };
  return new TauriEngine(await Database.load("sqlite:test.db"));
}

const engines: Array<[string, () => Promise<SqlEngine>]> = [
  ["sql.js", async () => (await makeTestEngine()).engine],
  ["tauri", makeTauriEngine],
];

describe.each(engines)("SqlEngine 契约（%s）", (_name, make) => {
  let engine: SqlEngine;
  beforeEach(async () => {
    engine = await make();
    await engine.execute("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");
    await engine.execute("DELETE FROM t");
  });

  it("execute 返回真实受影响行数", async () => {
    expect(await engine.execute("INSERT INTO t (v) VALUES (?), (?)", ["a", "b"])).toBe(2);
    expect(await engine.execute("UPDATE t SET v = 'x' WHERE v = ?", ["a"])).toBe(1);
    expect(await engine.execute("UPDATE t SET v = 'y' WHERE v = ?", ["missing"])).toBe(0);
  });

  it("select 返回列名为键的行", async () => {
    await engine.execute("INSERT INTO t (v) VALUES (?)", ["a"]);
    expect(await engine.select<{ v: string }>("SELECT v FROM t")).toEqual([{ v: "a" }]);
  });
});
