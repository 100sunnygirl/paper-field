// @vitest-environment node
import initSqlJs from "sql.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestEngine, type TestEngineHandle } from "../test/helpers";
import { applySchema, clearPremigrationBackup, premigrationBackup, type SqlEngine } from "./engine";
import { clear as clearLog, getEntries, log } from "./logger";
import { redactSecrets } from "./redact";
import { repo } from "./repo";
import { DOMAIN_CASCADE_SQL, PAPER_CASCADE_SQL, SCHEMA_VERSION, userVersion } from "./schema";
import type { PreparedMeta } from "./types";
import { arxivAbsUrl, doiUrl, safeHttpUrl } from "./urls";

const holder = vi.hoisted(() => ({ engine: null as SqlEngine | null }));

vi.mock("./engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine")>();
  return {
    ...actual,
    getEngine: () => Promise.resolve(holder.engine!),
  };
});

let handle: TestEngineHandle;

beforeEach(async () => {
  handle = await makeTestEngine();
  holder.engine = handle.engine;
  await handle.engine.execute("DELETE FROM app_meta");
  await handle.engine.execute("DELETE FROM notes");
  await handle.engine.execute("DELETE FROM paper_authors");
  await handle.engine.execute("DELETE FROM paper_parse");
  await handle.engine.execute("DELETE FROM llm_jobs");
  await handle.engine.execute("DELETE FROM papers");
  await handle.engine.execute("DELETE FROM authors");
  await handle.engine.execute("DELETE FROM domains");
});

afterEach(() => {
  handle.close();
});

function meta(patch: Partial<PreparedMeta> = {}): PreparedMeta {
  return {
    title: "API Title",
    titleZh: null,
    abstract: "API abstract",
    year: 2017,
    venue: "NeurIPS",
    doi: "10.1000/api",
    arxivId: "1706.03762",
    authors: [{ name: "Ashish Vaswani", affiliation: "Google Brain" }],
    labs: [],
    codeOpenSource: "unknown",
    codeURL: null,
    projectPage: null,
    pdfURL: "https://arxiv.org/pdf/1706.03762",
    tags: ["attention"],
    confidence: 0.91,
    ...patch,
  };
}

describe("著录合并：只补空白，飞行中的手改不被覆盖", () => {
  it("文件名标题可被文献库替换，用户填写的期刊保持 source=user", async () => {
    const domain = await repo.createDomain({ name: "多模态", code: "MM-01" });
    const paper = await repo.createPaper({
      domainId: domain.id,
      pdfPath: "/Users/reader/Downloads/Attention Is All You Need.pdf",
    });
    expect(paper.fieldSources?.title).toBeUndefined();
    await repo.updatePaper(paper.id, { venue: "手填期刊" }, true);
    const started = (await repo.getPaper(paper.id))!;

    await repo.applyPreparedMeta(paper.id, meta({ venue: "API Venue" }), false, {
      startedRev: started.metaRev,
      source: "api",
    });

    const detail = (await repo.getPaper(paper.id))!;
    expect(detail.title).toBe("API Title");
    expect(detail.fieldSources?.title).toBe("api");
    expect(detail.venue).toBe("手填期刊");
    expect(detail.fieldSources?.venue).toBe("user");
    expect(detail.abstract).toBe("API abstract");
    expect(detail.fieldSources?.abstract).toBe("api");
    expect(detail.metaConfidence).toBeCloseTo(0.91);
    expect(detail.llmPreparedAt).toBeNull();
  });

  it("overwrite=true 仍不覆盖请求发出后改过的字段", async () => {
    const domain = await repo.createDomain({ name: "多模态", code: "MM-01" });
    const paper = await repo.createPaper({ domainId: domain.id, title: "初稿标题", userOwned: true });
    const startedRev = paper.metaRev ?? 0;
    await repo.updatePaper(paper.id, { title: "飞行中修改" }, true);

    await repo.applyPreparedMeta(paper.id, meta({ title: "模型标题", venue: "NeurIPS" }), true, {
      startedRev,
      source: "llm",
    });

    const detail = (await repo.getPaper(paper.id))!;
    expect(detail.title).toBe("飞行中修改");
    expect(detail.fieldSources?.title).toBe("user");
    expect(detail.venue).toBe("NeurIPS");
    expect(detail.fieldSources?.venue).toBe("llm");
    expect(detail.llmPreparedAt).not.toBeNull();
  });
});

describe("链接只允许 http/https", () => {
  it("保存时丢掉 javascript: 与相对地址，保留 https", async () => {
    const domain = await repo.createDomain({ name: "多模态", code: "MM-01" });
    const paper = await repo.createPaper({ domainId: domain.id });
    await repo.updatePaper(paper.id, {
      codeUrl: "javascript:alert(1)",
      projectPage: "/relative/page",
      pdfUrl: "https://arxiv.org/pdf/1706.03762",
    });
    const detail = (await repo.getPaper(paper.id))!;
    expect(detail.codeUrl).toBeNull();
    expect(detail.projectPage).toBeNull();
    expect(detail.pdfUrl).toBe("https://arxiv.org/pdf/1706.03762");
    expect(safeHttpUrl("file:///tmp/a.pdf")).toBeNull();
    expect(arxivAbsUrl("1706.03762v1")).toBe("https://arxiv.org/abs/1706.03762");
    expect(doiUrl("https://doi.org/10.48550/arXiv.1706.03762")).toBe("https://doi.org/10.48550/arXiv.1706.03762");
  });
});

describe("作者按位置写入，空机构不合并同名", () => {
  it("两位同名且没有机构的作者仍是两行", async () => {
    const domain = await repo.createDomain({ name: "多模态", code: "MM-01" });
    const paper = await repo.createPaper({ domainId: domain.id });
    await repo.replaceAuthors(paper.id, [
      { name: "Wei Wang", affiliation: "" },
      { name: "Wei Wang" },
    ]);
    const detail = (await repo.getPaper(paper.id))!;
    expect(detail.authors.map((author) => author.name)).toEqual(["Wei Wang", "Wei Wang"]);
    const rows = await handle.engine.select<{ c: number }>(
      "SELECT COUNT(*) AS c FROM paper_authors WHERE paper_id = ?",
      [paper.id],
    );
    expect(Number(rows[0]?.c)).toBe(2);
  });
});

describe("笔记覆盖时来源写成模型", () => {
  it("overwrite=true 把用户改过的笔记块改回 source=llm 并清掉 user_edited", async () => {
    const domain = await repo.createDomain({ name: "多模态", code: "MM-01" });
    const paper = await repo.createPaper({ domainId: domain.id });
    await repo.updateNote(paper.id, "summary", "我改过的总结");
    await repo.applyDraftedNotes(
      paper.id,
      { remarks: "", summary: "模型总结", highlights: "", weaknesses: "", implications: "" },
      true,
    );
    const detail = (await repo.getPaper(paper.id))!;
    expect(detail.notes.summary.content).toBe("模型总结");
    expect(detail.notes.summary.source).toBe("llm");
    expect(detail.notes.summary.userEdited).toBe(false);
  });
});

describe("作业取消与写入竞态", () => {
  it("取消之后的完成写入无效，著录也不再套用", async () => {
    const domain = await repo.createDomain({ name: "多模态", code: "MM-01" });
    const paper = await repo.createPaper({
      domainId: domain.id,
      pdfPath: "/papers/Attention Is All You Need.pdf",
    });
    const job = await repo.createJob(paper.id, "prepareMeta", "prompt");
    expect(await repo.updateJob(job.id, { status: "running", startedAt: "2024-01-01T00:00:01.000Z" })).toBe(true);
    await repo.applyPreparedMeta(paper.id, meta({ title: "API Title" }), false, {
      source: "api",
      jobId: job.id,
    });
    expect((await repo.getPaper(paper.id))!.title).toBe("API Title");

    expect(await repo.updateJob(job.id, { status: "cancelled", error: "cancelled", finishedAt: "2024-01-01T00:00:02.000Z" })).toBe(true);
    expect(await repo.updateJob(job.id, { status: "done", resultJson: "{}", finishedAt: "2024-01-01T00:00:03.000Z" })).toBe(false);
    expect(await repo.jobStatus(job.id)).toBe("cancelled");

    await repo.applyPreparedMeta(paper.id, meta({ title: "晚到的标题" }), true, {
      source: "llm",
      jobId: job.id,
    });
    expect((await repo.getPaper(paper.id))!.title).toBe("API Title");
  });
});

describe("日志与错误文案脱敏", () => {
  it("sk- 与 Bearer 片段不会进入缓冲", async () => {
    await clearLog();
    expect(redactSecrets("failed sk-abcDEF1234 Bearer abc.def/token")).toBe("failed sk-… Bearer …");
    log.error("llm", "请求失败 sk-supersecretkey", "Authorization: Bearer eyJhbGciOi.payload");
    const entry = getEntries().at(-1);
    expect(entry?.message).toBe("请求失败 sk-…");
    expect(entry?.detail).not.toContain("eyJ");
    expect(entry?.detail).toContain("Bearer …");
  });
});

describe("旧库迁移", () => {
  it("user_version 0 的旧表补列、回填来源、替换触发器，并先复制一份数据库", async () => {
    clearPremigrationBackup();
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    const engine: SqlEngine = {
      async execute(sql: string, params: unknown[] = []) {
        db.run(sql, params as (string | number | null | Uint8Array)[]);
        return db.getRowsModified();
      },
      snapshot: () => db.export(),
      async select<T>(sql: string, params: unknown[] = []) {
        const stmt = db.prepare(sql);
        try {
          stmt.bind(params as (string | number | null | Uint8Array)[]);
          const rows: T[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject() as T);
          return rows;
        } finally {
          stmt.free();
        }
      },
    };

    db.run(`CREATE TABLE papers (
      id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL,
      title TEXT NOT NULL,
      title_zh TEXT,
      abstract TEXT NOT NULL DEFAULT '',
      year INTEGER,
      venue TEXT,
      doi TEXT,
      arxiv_id TEXT,
      pdf_url TEXT,
      pdf_path TEXT,
      code_url TEXT,
      code_open_source TEXT NOT NULL DEFAULT 'unknown',
      project_page TEXT,
      reading_status TEXT NOT NULL DEFAULT 'unread',
      read_at TEXT,
      llm_prepared_at TEXT,
      notes_drafted_by_llm INTEGER NOT NULL DEFAULT 0,
      user_notes_touched INTEGER NOT NULL DEFAULT 0,
      user_meta_touched INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]',
      labs TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE authors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_zh TEXT,
      affiliation TEXT,
      lab TEXT,
      homepage TEXT,
      orcid TEXT
    )`);
    db.run(`CREATE TABLE paper_authors (
      paper_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      is_corresponding INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (paper_id, author_id)
    )`);
    db.run(`CREATE TRIGGER pf_paper_cascade
      AFTER DELETE ON papers
      BEGIN
        SELECT 1;
      END`);
    db.run(
      `INSERT INTO papers (id, domain_id, title, venue, user_meta_touched, tags, labs, created_at, updated_at)
       VALUES ('p-old', 'd-old', '存量论文', 'ICLR', 0, '[]', '[]', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO papers (id, domain_id, title, user_meta_touched, tags, labs, created_at, updated_at)
       VALUES ('p-user', 'd-old', '手改过', 1, '[]', '[]', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO papers (id, domain_id, title, user_meta_touched, tags, labs, created_at, updated_at)
       VALUES ('p-blank', 'd-old', '未命名论文', 0, '[]', '[]', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
    );
    db.run("INSERT INTO authors (id, name) VALUES ('a-1', 'Wei Wang')");
    db.run("INSERT INTO paper_authors (paper_id, author_id, sort_order) VALUES ('p-old', 'a-1', 0)");

    await applySchema(engine);

    expect(await userVersion(engine)).toBe(SCHEMA_VERSION);
    const cols = await engine.select<{ name: string }>("PRAGMA table_info(papers)");
    const names = cols.map((col) => col.name);
    for (const col of ["mineru_provider", "field_sources", "meta_confidence", "meta_rev", "pdf_original_path"]) {
      expect(names).toContain(col);
    }
    const pk = await engine.select<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'paper_authors'",
    );
    expect(pk[0]?.sql).toContain("PRIMARY KEY (paper_id, sort_order)");

    const triggers = await engine.select<{ name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    );
    const collapsed = (sql: string) => sql.replace(/\s+/g, " ").trim();
    const paperTrigger = triggers.find((row) => row.name === "pf_paper_cascade")?.sql ?? "";
    const domainTrigger = triggers.find((row) => row.name === "pf_domain_cascade")?.sql ?? "";
    const paperBody = collapsed(PAPER_CASCADE_SQL);
    const domainBody = collapsed(DOMAIN_CASCADE_SQL);
    expect(collapsed(paperTrigger)).toContain(paperBody.slice(paperBody.indexOf("BEGIN")));
    expect(paperTrigger).not.toContain("SELECT 1");
    expect(collapsed(domainTrigger)).toContain(domainBody.slice(domainBody.indexOf("BEGIN")));

    const sources = await engine.select<{ id: string; field_sources: string }>(
      "SELECT id, field_sources FROM papers ORDER BY id",
    );
    const byId = Object.fromEntries(sources.map((row) => [row.id, JSON.parse(row.field_sources) as Record<string, string>]));
    expect(byId["p-old"].title).toBe("llm");
    expect(byId["p-old"].venue).toBe("llm");
    expect(byId["p-old"].authors).toBe("llm");
    expect(byId["p-user"].title).toBe("user");
    expect(byId["p-blank"].title).toBeUndefined();

    const backup = premigrationBackup();
    expect(backup).not.toBeNull();
    const previous = new SQL.Database(backup!);
    const info = previous.exec("PRAGMA table_info(papers)");
    const oldCols = (info[0]?.values ?? []).map((row) => String(row[1]));
    expect(oldCols).not.toContain("field_sources");
    expect(oldCols).toContain("title");
    previous.close();
    db.close();
  });
});
