import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { applySchema, SqlJsEngine, type BatchStep, type SqlEngine } from "./engine";
import { runMigrations, SCHEMA_VERSION, userVersion } from "./schema";

async function rawDb() {
  const SQL = await initSqlJs();
  return new SQL.Database();
}

describe("迁移按版本原子提交", () => {
  it("某一版中途失败：该版全部回滚，版本号不变，修好后重跑成功", async () => {
    const db = await rawDb();
    const engine = new SqlJsEngine(db, { persist: false });
    await runMigrations(engine, 0);
    expect(await userVersion(engine)).toBe(SCHEMA_VERSION);

    // 回到 V5 之前的状态，再让 V6 的第二步失败
    const failing: SqlEngine = {
      execute: (sql, params) => engine.execute(sql, params),
      select: (sql, params) => engine.select(sql, params),
      batch: (steps: BatchStep[]) =>
        engine.batch(steps.map((step, index) => (index === 1 ? { sql: "INSERT INTO no_such_table VALUES (1)" } : step))),
    };
    db.run("PRAGMA user_version = 5");
    db.run("ALTER TABLE notes DROP COLUMN rev");
    db.run("ALTER TABLE papers DROP COLUMN mineru_job_id");
    await expect(runMigrations(failing, 5)).rejects.toThrow();
    expect(await userVersion(engine)).toBe(5);
    const cols = await engine.select<{ name: string }>("SELECT name FROM pragma_table_info('notes') WHERE name = 'rev'");
    expect(cols).toEqual([]);

    await runMigrations(engine, 5);
    expect(await userVersion(engine)).toBe(6);
  });

  it("修复旧版非事务迁移在 DROP 与 RENAME 之间崩溃留下的库", async () => {
    const db = await rawDb();
    const engine = new SqlJsEngine(db, { persist: false });
    await runMigrations(engine, 0);
    db.run("DROP TRIGGER IF EXISTS pf_domain_cascade");
    db.run("DROP TRIGGER IF EXISTS pf_paper_cascade");
    db.run("DROP TRIGGER IF EXISTS pf_author_replace");
    db.run("ALTER TABLE paper_authors RENAME TO paper_authors_next");
    db.run("PRAGMA user_version = 2");
    await applySchema(engine);
    expect(await userVersion(engine)).toBe(SCHEMA_VERSION);
    const tables = await engine.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'paper_authors%' ORDER BY name",
    );
    expect(tables.map((t) => t.name)).toEqual(["paper_authors"]);
  });

  it("V3 在主体完成、版本号未写时重跑不再报 trigger 引用错误", async () => {
    const db = await rawDb();
    const engine = new SqlJsEngine(db, { persist: false });
    await runMigrations(engine, 0);
    db.run("PRAGMA user_version = 2");
    await applySchema(engine);
    expect(await userVersion(engine)).toBe(SCHEMA_VERSION);
  });

  it("V6 把文件名标题改记 file 来源，未提交解析的论文记 pending", async () => {
    const db = await rawDb();
    const engine = new SqlJsEngine(db, { persist: false });
    await runMigrations(engine, 0);
    db.run("PRAGMA user_version = 5");
    db.run("ALTER TABLE notes DROP COLUMN rev");
    db.run("ALTER TABLE papers DROP COLUMN mineru_job_id");
    db.run("INSERT INTO domains (id, name, code, sort_order, created_at) VALUES ('d', 'D', 'D-01', 1, 'now')");
    db.run(
      `INSERT INTO papers (id, domain_id, title, pdf_path, pdf_original_path, field_sources, created_at, updated_at)
       VALUES ('a', 'd', 'attention', '/lib/1700-attention.pdf', '/home/u/attention.pdf', '{"title":"llm"}', 'now', 'now'),
              ('b', 'd', 'Real Title', '/lib/1700-x.pdf', NULL, '{"title":"llm"}', 'now', 'now')`,
    );
    await runMigrations(engine, 5);
    const rows = await engine.select<{ id: string; src: string; status: string | null }>(
      "SELECT id, json_extract(field_sources, '$.title') AS src, mineru_status AS status FROM papers ORDER BY id",
    );
    expect(rows).toEqual([
      { id: "a", src: "file", status: "pending" },
      { id: "b", src: "llm", status: "pending" },
    ]);
  });
});
