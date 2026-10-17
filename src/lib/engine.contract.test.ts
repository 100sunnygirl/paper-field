import initSqlJs from "sql.js";
import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, expectMet, TauriEngine, type BatchStep, type SqlEngine } from "./engine";
import { makeTestEngine } from "../test/helpers";

/**
 * 用 sql.js 模拟 Rust 的 db_* 命令（含真实的报错结构 { kind: "conflict", step } /
 * { kind: "sql", message }），让 TauriEngine 走生产时的 IPC 协议。
 * Rust 侧的事务、授权与语句检查由 src-tauri/src/db.rs 的单测覆盖。
 */
async function makeTauriEngine(): Promise<SqlEngine> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const params = (values: unknown) => (values ?? []) as (string | number | null)[];
  const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      if (cmd === "db_execute") {
        db.run(args!.sql as string, params(args!.params));
        return db.getRowsModified() as T;
      }
      if (cmd === "db_select") {
        const stmt = db.prepare(args!.sql as string);
        stmt.bind(params(args!.params));
        const rows: unknown[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows as T;
      }
      if (cmd === "db_batch") {
        const steps = args!.steps as Required<BatchStep>[];
        const out: number[] = [];
        db.run("BEGIN");
        for (const [index, step] of steps.entries()) {
          db.run(step.sql, params(step.params));
          const rows = db.getRowsModified();
          if (!expectMet(step.expect, rows)) {
            db.run("ROLLBACK");
            throw { kind: "conflict", step: index };
          }
          out.push(rows);
        }
        db.run("COMMIT");
        return out as T;
      }
    } catch (err) {
      if (err && typeof err === "object" && "kind" in err) throw err;
      if (db.getRowsModified() >= 0) {
        try {
          db.run("ROLLBACK");
        } catch {
          // 不在事务里
        }
      }
      throw { kind: "sql", message: err instanceof Error ? err.message : String(err) };
    }
    throw new Error(`unexpected IPC ${cmd}`);
  };
  return new TauriEngine(invoke);
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

  it("batch 全部成功才提交，返回每步行数", async () => {
    const rows = await engine.batch([
      { sql: "INSERT INTO t (v) VALUES (?)", params: ["a"], expect: "one" },
      { sql: "UPDATE t SET v = 'b' WHERE v = 'a'", expect: "some" },
    ]);
    expect(rows).toEqual([1, 1]);
    expect(await engine.select("SELECT v FROM t")).toEqual([{ v: "b" }]);
  });

  it("前提不成立时整批回滚并抛 ConflictError（带步号）", async () => {
    await expect(
      engine.batch([
        { sql: "INSERT INTO t (v) VALUES (?)", params: ["a"], expect: "one" },
        { sql: "UPDATE t SET v = 'z' WHERE v = 'missing'", expect: "one" },
      ]),
    ).rejects.toEqual(new ConflictError(1));
    expect(await engine.select("SELECT v FROM t")).toEqual([]);
  });

  it("SQL 错误时整批回滚，报普通 Error", async () => {
    const err = await engine
      .batch([
        { sql: "INSERT INTO t (v) VALUES ('a')" },
        { sql: "INSERT INTO nope VALUES (1)" },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConflictError);
    expect(await engine.select("SELECT v FROM t")).toEqual([]);
  });
});
