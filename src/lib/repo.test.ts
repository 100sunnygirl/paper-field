// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestEngine, type TestEngineHandle } from "../test/helpers";
import type { SqlEngine } from "./engine";
import { repo } from "./repo";

/**
 * node + sql.js 内存库：vi.mock("./engine") 把 getEngine 指向内存实例，
 * 建表走生产 applySchema（SCHEMA_STATEMENTS + PAPER_MIGRATIONS + 索引），
 * 不触碰 IndexedDB 与 Tauri。
 */
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
  const { engine } = handle;
  holder.engine = engine;
  // 空 app_meta 标记：让 seedIfEmpty 的行为由各用例自行控制。
  await engine.execute("DELETE FROM app_meta");
  await engine.execute("DELETE FROM notes");
  await engine.execute("DELETE FROM paper_authors");
  await engine.execute("DELETE FROM paper_parse");
  await engine.execute("DELETE FROM llm_jobs");
  await engine.execute("DELETE FROM papers");
  await engine.execute("DELETE FROM authors");
  await engine.execute("DELETE FROM domains");
});

afterEach(() => {
  handle.close();
});

async function makeDomain(code = "MM-01"): Promise<string> {
  const domain = await repo.createDomain({ name: `领域 ${code}`, code, summary: "测试领域" });
  return domain.id;
}

describe("applySchema（makeTestEngine 与生产同构建表）", () => {
  it("核心表与迁移列全部存在（含 idx_papers_pdf_path 索引）", async () => {
    const engine = holder.engine!;
    const tables = await engine.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = tables.map((row) => row.name);
    for (const table of ["domains", "papers", "paper_parse", "authors", "paper_authors", "notes", "llm_jobs", "app_meta"]) {
      expect(names).toContain(table);
    }
    const cols = await engine.select<{ name: string }>("PRAGMA table_info(papers)");
    const colNames = cols.map((row) => row.name);
    for (const col of ["pdf_path", "user_meta_touched", "mineru_status", "mineru_provider", "mineru_parse_ids", "labs", "mineru_cred_fingerprint"]) {
      expect(colNames).toContain(col);
    }
    const indexes = await engine.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='papers'",
    );
    expect(indexes.map((row) => row.name)).toContain("idx_papers_pdf_path");
  });
});

describe("createPaper（缺陷 13：无 pdfPath 建档）", () => {
  it("无 pdfPath 无 title 也能建档成功", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    expect(paper.pdfPath).toBeNull();
    expect(paper.title).toBe("未命名论文");
    expect(paper.readingStatus).toBe("unread");
    const detail = await repo.getPaper(paper.id);
    expect(detail).not.toBeNull();
    expect(detail?.title).toBe("未命名论文");
    // 五块笔记占位已建
    expect(Object.keys(detail?.notes ?? {})).toHaveLength(5);
  });

  it("pdfPath 存在时用文件名推导标题", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId, pdfPath: "/Users/reader/Downloads/Attention Is All You Need.pdf" });
    expect(paper.title).toBe("Attention Is All You Need");
    expect(paper.pdfPath).toBe("/Users/reader/Downloads/Attention Is All You Need.pdf");
  });

  it("显式 title 优先于文件名", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId, pdfPath: "/x/a.pdf", title: "  手动标题  " });
    expect(paper.title).toBe("手动标题");
  });
});

describe("importLocalPdfs（重复导入）", () => {
  it("库中已有路径进 skipped，新路径进 created", async () => {
    const domainId = await makeDomain();
    await repo.importLocalPdfs(domainId, ["/papers/a.pdf"]);
    const result = await repo.importLocalPdfs(domainId, ["/papers/a.pdf", "/papers/b.pdf"]);
    expect(result.created.map((p) => p.pdfPath)).toEqual(["/papers/b.pdf"]);
    expect(result.skipped).toEqual(["/papers/a.pdf"]);
    const paths = await repo.pdfPaths();
    expect(paths.sort()).toEqual(["/papers/a.pdf", "/papers/b.pdf"]);
  });

  it("同一批内重复路径只建档一次", async () => {
    const domainId = await makeDomain();
    const result = await repo.importLocalPdfs(domainId, ["/papers/a.pdf", "/papers/a.pdf"]);
    expect(result.created).toHaveLength(1);
    expect(await repo.pdfPaths()).toEqual(["/papers/a.pdf"]);
  });
});

describe("setReadingStatus（缺陷 11：read_at 往返）", () => {
  it("read→reading→read 保留最初标记已读的时间，不被覆盖", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    await repo.setReadingStatus(paper.id, "read");
    const engine = holder.engine!;
    // 手工预置历史时间，避免同毫秒无法区分。
    const historic = "2020-01-01T00:00:00.000Z";
    await engine.execute("UPDATE papers SET read_at = ? WHERE id = ?", [historic, paper.id]);

    await repo.setReadingStatus(paper.id, "reading");
    let row = (await repo.getPaper(paper.id))!;
    expect(row.readingStatus).toBe("reading");
    expect(row.readAt).toBe(historic);

    await repo.setReadingStatus(paper.id, "read");
    row = (await repo.getPaper(paper.id))!;
    expect(row.readingStatus).toBe("read");
    expect(row.readAt).toBe(historic);
  });

  it("read→read 不改写已记录的 read_at", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    const historic = "2020-01-01T00:00:00.000Z";
    await holder.engine!.execute("UPDATE papers SET read_at = ? WHERE id = ?", [historic, paper.id]);
    await repo.setReadingStatus(paper.id, "read");
    expect((await repo.getPaper(paper.id))!.readAt).toBe(historic);
  });

  it("unread→read 写入时间，再 unread 清空", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    await repo.setReadingStatus(paper.id, "read");
    expect((await repo.getPaper(paper.id))!.readAt).not.toBeNull();
    await repo.setReadingStatus(paper.id, "unread");
    const row = (await repo.getPaper(paper.id))!;
    expect(row.readingStatus).toBe("unread");
    expect(row.readAt).toBeNull();
  });
});

describe("replaceAuthors（缺陷 10：同名作者隔离）", () => {
  it("改 A 论文作者机构不影响 B 论文的同名作者", async () => {
    const domainId = await makeDomain();
    const a = await repo.createPaper({ domainId, title: "A 论文" });
    const b = await repo.createPaper({ domainId, title: "B 论文" });
    await repo.replaceAuthors(a.id, [{ name: "Alice", affiliation: "Stanford", lab: "Lab S" }]);
    await repo.replaceAuthors(b.id, [{ name: "Alice", affiliation: "Stanford", lab: "Lab S" }]);

    // A 论文把 Alice 的机构改成 MIT：应新插一行，而不是改写共享行。
    await repo.replaceAuthors(a.id, [{ name: "Alice", affiliation: "MIT", lab: "Lab M" }], true);

    const detailA = (await repo.getPaper(a.id))!;
    const detailB = (await repo.getPaper(b.id))!;
    expect(detailA.authors[0].affiliation).toBe("MIT");
    expect(detailB.authors[0].affiliation).toBe("Stanford");

    // 全局 authors 表出现两行 Alice（不同机构），互不覆盖。
    const engine = holder.engine!;
    const rows = await engine.select<{ affiliation: string }>(
      "SELECT affiliation FROM authors WHERE lower(name) = 'alice' ORDER BY affiliation",
    );
    expect(rows.map((row) => row.affiliation)).toEqual(["MIT", "Stanford"]);
  });

  it("touchMeta=true 时置 user_meta_touched（AI 编辑锁生效依据）", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    await repo.replaceAuthors(paper.id, [{ name: "Bob", affiliation: "MIT" }], true);
    expect((await repo.getPaper(paper.id))!.userMetaTouched).toBe(true);
  });
});

describe("seedIfEmpty（缺陷 5：持久播种标记）", () => {
  it("全新空库首启播种演示数据并写入 seeded 标记", async () => {
    await repo.init();
    const domains = await repo.listDomains();
    expect(domains.map((d) => d.code)).toEqual(["MM-01", "AL-02"]);
    const papers = await repo.listPapers(domains[0].id);
    expect(papers.length).toBeGreaterThanOrEqual(2);
    const engine = holder.engine!;
    const meta = await engine.select<{ value: string }>(
      "SELECT value FROM app_meta WHERE key = 'seeded'",
    );
    expect(meta).toHaveLength(1);
  });

  it("存量库（有数据无标记）只补标记不重新播种；清空后二次 init 演示数据不复活", async () => {
    const engine = holder.engine!;
    // 模拟现有用户：手工预置一个领域与论文，app_meta 无 seeded 标记。
    await engine.execute(
      "INSERT INTO domains (id, name, code, sort_order, created_at) VALUES ('d-legacy', '存量领域', 'LG-99', 1, '2024-01-01T00:00:00.000Z')",
    );
    await engine.execute(
      `INSERT INTO papers (id, domain_id, title, tags, labs, created_at, updated_at)
       VALUES ('p-legacy', 'd-legacy', '存量论文', '[]', '[]', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
    );

    await repo.init();
    // 标记被补写
    const meta = await engine.select<{ c: number }>(
      "SELECT COUNT(*) AS c FROM app_meta WHERE key = 'seeded'",
    );
    expect(Number(meta[0]?.c)).toBe(1);
    // 未重新播种：领域仍只有存量一个，论文标题仍是存量标题
    const domains = await repo.listDomains();
    expect(domains).toHaveLength(1);
    expect(domains[0].code).toBe("LG-99");
    const papers = await repo.listPapers(domains[0].id);
    expect(papers.map((p) => p.title)).toEqual(["存量论文"]);

    // 用户随后删光所有领域，再启动：演示数据不得复活。
    await repo.deleteDomain("d-legacy");
    await repo.init();
    expect(await repo.listDomains()).toEqual([]);
    expect(await repo.listArchive({})).toEqual([]);
  });
});

describe("repo.init 启动清扫（缺陷 4：残留作业）", () => {
  it("把上次退出残留的 queued/running 作业清为 error，done 不动", async () => {
    const engine = holder.engine!;
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    for (const [id, status] of [
      ["job-q", "queued"],
      ["job-r", "running"],
      ["job-d", "done"],
    ] as const) {
      await engine.execute(
        `INSERT INTO llm_jobs (id, paper_id, type, status, prompt, created_at)
         VALUES (?, ?, 'prepareMeta', ?, NULL, '2024-01-01T00:00:00.000Z')`,
        [id, paper.id, status],
      );
    }

    await repo.init();

    const rows = await engine.select<{ id: string; status: string; error: string | null }>(
      "SELECT id, status, error FROM llm_jobs ORDER BY id",
    );
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId["job-q"].status).toBe("error");
    expect(byId["job-q"].error).toBe("应用上次退出，作业中断");
    expect(byId["job-r"].status).toBe("error");
    expect(byId["job-r"].error).toBe("应用上次退出，作业中断");
    expect(byId["job-d"].status).toBe("done");
    expect(byId["job-d"].error).toBeNull();
  });
});

describe("三种模式搜索（缺陷 1：作者/DOI/标签命中）", () => {
  let domainA: string;
  let domainB: string;

  beforeEach(async () => {
    domainA = await makeDomain("DA-01");
    domainB = await makeDomain("DB-02");
    const p1 = await repo.createPaper({ domainId: domainA, title: "Vision Transformer" });
    await repo.updatePaper(p1.id, { doi: "10.1000/vit.2021", tags: ["transformer", "vision"] });
    await repo.replaceAuthors(p1.id, [{ name: "Long Ouyang", affiliation: "OpenAI" }]);
    const p2 = await repo.createPaper({ domainId: domainB, title: "Contrastive Learning" });
    await repo.updatePaper(p2.id, { abstract: "CLIP style pretraining with tags embedded" });
    await repo.replaceAuthors(p2.id, [{ name: "Alec Radford" }]);
    const p3 = await repo.createPaper({ domainId: domainA, title: "已读的老论文" });
    await repo.setReadingStatus(p3.id, "read");
  });

  it("listPapers：按作者名命中，且只限当前领域", async () => {
    const hits = await repo.listPapers(domainA, "Ouyang");
    expect(hits.map((p) => p.title)).toEqual(["Vision Transformer"]);
    const other = await repo.listPapers(domainB, "Ouyang");
    expect(other).toEqual([]);
  });

  it("listPapers：按 DOI 与标签命中", async () => {
    expect((await repo.listPapers(domainA, "10.1000/vit.2021")).map((p) => p.title)).toEqual(["Vision Transformer"]);
    expect((await repo.listPapers(domainA, "transformer")).map((p) => p.title)).toEqual(["Vision Transformer"]);
  });

  it("listIntake：按作者与 DOI 命中，且只收未读论文", async () => {
    const byAuthor = await repo.listIntake("Radford");
    expect(byAuthor.map((p) => p.title)).toEqual(["Contrastive Learning"]);
    const byDoi = await repo.listIntake("vit.2021");
    expect(byDoi.map((p) => p.title)).toEqual(["Vision Transformer"]);
    const all = await repo.listIntake("");
    expect(all.map((p) => p.title).sort()).toEqual(["Contrastive Learning", "Vision Transformer"]);
  });

  it("listIntake：已读论文不出现，除非有活跃作业", async () => {
    expect((await repo.listIntake("已读")).map((p) => p.title)).toEqual([]);
    const engine = holder.engine!;
    const p3 = (await repo.listPapers(domainA, "已读的老论文"))[0];
    await engine.execute(
      `INSERT INTO llm_jobs (id, paper_id, type, status, prompt, created_at)
       VALUES ('job-x', ?, 'draftNotes', 'running', NULL, '2024-01-01T00:00:00.000Z')`,
      [p3.id],
    );
    expect((await repo.listIntake("已读")).map((p) => p.title)).toEqual(["已读的老论文"]);
  });

  it("listArchive：按作者与标签命中，且只收已读论文", async () => {
    const read = (await repo.listPapers(domainA, "已读的老论文"))[0];
    await repo.replaceAuthors(read.id, [{ name: "Kate Reading", affiliation: "MIT" }]);
    await repo.updatePaper(read.id, { tags: ["archive-tag"] });

    const byAuthor = await repo.listArchive({ search: "Kate Reading" });
    expect(byAuthor.map((p) => p.title)).toEqual(["已读的老论文"]);
    const byTag = await repo.listArchive({ search: "archive-tag" });
    expect(byTag.map((p) => p.title)).toEqual(["已读的老论文"]);
    // 未读论文即使匹配也不进归档。
    expect((await repo.listArchive({ search: "Ouyang" })).map((p) => p.title)).toEqual([]);
    // openSource 过滤。
    await repo.updatePaper(read.id, { codeOpenSource: "open" });
    expect((await repo.listArchive({ search: "archive-tag", openSource: "open" })).map((p) => p.title)).toEqual([
      "已读的老论文",
    ]);
    expect(await repo.listArchive({ search: "archive-tag", openSource: "closed" })).toEqual([]);
  });

  it("searchAll：跨领域命中（作者 / 摘要）", async () => {
    const hits = await repo.searchAll("Radford");
    expect(hits.map((p) => p.title)).toEqual(["Contrastive Learning"]);
    expect(hits[0].domainCode).toBe("DB-02");
    expect(await repo.searchAll("")).toEqual([]);
  });

  it("labs JSON 文本可被搜索命中", async () => {
    const paper = (await repo.listPapers(domainA, "Vision Transformer"))[0];
    await repo.updatePaper(paper.id, {
      labs: [{ name: "Liu Lab", institution: "UW-Madison" }],
    });
    expect((await repo.listPapers(domainA, "UW-Madison")).map((p) => p.title)).toEqual(["Vision Transformer"]);
  });
});

describe("updatePaper / applyPreparedMeta（用户编辑锁）", () => {
  it("updatePaper 持久化字段并往返读回", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    await repo.updatePaper(
      paper.id,
      {
        title: "New Title",
        titleZh: "新标题",
        year: 2024,
        venue: "NeurIPS",
        doi: "10.1/x",
        tags: ["a", "b"],
        labs: [{ name: "L", institution: "I" }],
      },
      true,
    );
    const detail = (await repo.getPaper(paper.id))!;
    expect(detail.title).toBe("New Title");
    expect(detail.titleZh).toBe("新标题");
    expect(detail.year).toBe(2024);
    expect(detail.venue).toBe("NeurIPS");
    expect(detail.tags).toEqual(["a", "b"]);
    expect(detail.labs).toEqual([{ name: "L", institution: "I" }]);
    expect(detail.userMetaTouched).toBe(true);
  });

  it("applyPreparedMeta(overwrite=false)：手改过的字段保留、空白字段补全", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId, title: "手改标题" });
    await repo.updatePaper(paper.id, { venue: "手填期刊" }, true);

    await repo.applyPreparedMeta(paper.id, {
      title: "AI 标题",
      titleZh: "AI 中文标题",
      abstract: "AI 摘要",
      year: 2023,
      venue: "AI 期刊",
      doi: "10.2/y",
      arxivId: null,
      authors: [{ name: "Alice", affiliation: "MIT" }],
      labs: [],
      codeOpenSource: "open",
      codeURL: null,
      projectPage: null,
      pdfURL: null,
      tags: ["ai"],
    });

    const detail = (await repo.getPaper(paper.id))!;
    expect(detail.title).toBe("手改标题"); // 锁定
    expect(detail.venue).toBe("手填期刊"); // 锁定
    expect(detail.titleZh).toBe("AI 中文标题"); // 空白补全
    expect(detail.abstract).toBe("AI 摘要");
    // 标识符只能来自用户或文献库：模型给的年份与 DOI 不写
    expect(detail.year).toBeNull();
    expect(detail.doi).toBeNull();
    // 用户已有作者（0 个 → 视为空白）时 AI 作者补入
    expect(detail.authors.map((a) => a.name)).toEqual(["Alice"]);
    expect(detail.llmPreparedAt).not.toBeNull();
  });

  it("applyPreparedMeta(overwrite=true)：覆盖用户修改", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId, title: "手改标题" });
    await repo.updatePaper(paper.id, { venue: "手填期刊" }, true);
    await repo.applyPreparedMeta(
      paper.id,
      {
        title: "AI 标题",
        titleZh: null,
        abstract: "",
        year: null,
        venue: "AI 期刊",
        doi: null,
        arxivId: null,
        authors: [],
        labs: [],
        codeOpenSource: "unknown",
        codeURL: null,
        projectPage: null,
        pdfURL: null,
        tags: [],
      },
      true,
    );
    const detail = (await repo.getPaper(paper.id))!;
    expect(detail.title).toBe("AI 标题");
    expect(detail.venue).toBe("AI 期刊");
  });
});

describe("作者替换与 meta_rev（M4-P4）", () => {
  it("写入前用户改了作者：整批冲突回滚，重读后保留用户作者", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    await repo.replaceAuthors(paper.id, [{ name: "Alice", affiliation: "Old Lab" }]);
    const before = (await repo.getPaper(paper.id))!.authors.map((author) => author.name);

    const inner = holder.engine!;
    let bumped = false;
    const wrapped: SqlEngine = {
      execute: (sql, params) => inner.execute(sql, params),
      select: (sql, params) => inner.select(sql, params),
      batch: async (steps) => {
        // 模拟用户在补全读快照之后、写入之前保存了作者（来源 user，meta_rev 升高）
        if (!bumped && steps.some((step) => /author_replace/.test(step.sql))) {
          bumped = true;
          await inner.execute(
            "UPDATE papers SET meta_rev = meta_rev + 1, field_sources = json_set(field_sources, '$.authors', 'user') WHERE id = ?",
            [paper.id],
          );
        }
        return inner.batch(steps);
      },
    };
    holder.engine = wrapped;

    await repo.applyPreparedMeta(
      paper.id,
      {
        title: "新标题",
        titleZh: null,
        abstract: "摘要",
        year: 2017,
        venue: "NeurIPS",
        doi: null,
        arxivId: null,
        authors: [{ name: "Bob", affiliation: "New Lab" }],
        labs: [],
        codeOpenSource: "unknown",
        codeURL: null,
        projectPage: null,
        pdfURL: null,
        tags: [],
      },
      false,
      { source: "llm" },
    );

    expect((await repo.getPaper(paper.id))!.authors.map((author) => author.name)).toEqual(before);
    const links = await inner.select<{ c: number }>(
      "SELECT COUNT(*) AS c FROM paper_authors WHERE paper_id = ?",
      [paper.id],
    );
    expect(Number(links[0]?.c)).toBe(before.length);
    expect(bumped).toBe(true);
  });
});

describe("笔记与草稿", () => {
  it("updateNote 更新内容并置 user_notes_touched", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    await repo.updateNote(paper.id, "summary", "我的总结");
    const detail = (await repo.getPaper(paper.id))!;
    expect(detail.notes.summary.content).toBe("我的总结");
    expect(detail.notes.summary.userEdited).toBe(true);
    expect(detail.userNotesTouched).toBe(true);
  });

  it("applyDraftedNotes：不覆盖时保留用户改过的块，只写未改过的块", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    await repo.updateNote(paper.id, "summary", "我改过的笔记");
    await repo.applyDraftedNotes(
      paper.id,
      { remarks: "r", summary: "s", highlights: "h", weaknesses: "w", implications: "i" },
      false,
    );
    const detail = (await repo.getPaper(paper.id))!;
    expect(detail.notes.summary.content).toBe("我改过的笔记");
    expect(detail.notes.summary.source).toBe("manual");
    expect(detail.notes.highlights.content).toBe("h");
    expect(detail.notes.highlights.source).toBe("llm");
  });

  it("applyDraftedNotes(overwrite=true)：写入五块 AI 笔记并标记来源", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    await repo.applyDraftedNotes(
      paper.id,
      { remarks: "r", summary: "s", highlights: "h", weaknesses: "w", implications: "i" },
      true,
    );
    const detail = (await repo.getPaper(paper.id))!;
    expect(detail.notes.summary.content).toBe("s");
    expect(detail.notes.summary.source).toBe("llm");
    expect(detail.notes.remarks.content).toBe("r");
    expect(detail.notes.implications.content).toBe("i");
    expect(detail.notesDraftedByLlm).toBe(true);
  });
});

describe("作业 CRUD 与统计", () => {
  it("createJob/updateJob/listJobs 生命周期", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    const job = await repo.createJob(paper.id, "prepareMeta", "prompt-text");
    expect(job.status).toBe("queued");
    await repo.updateJob(job.id, { status: "running", startedAt: "2024-01-01T00:00:01.000Z" });
    await repo.updateJob(job.id, { status: "done", resultJson: "{}", finishedAt: "2024-01-01T00:00:02.000Z" });
    const jobs = await repo.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("done");
    expect(jobs[0].paperTitle).toBe(paper.title);
    expect(jobs[0].domainName).toContain("MM-01");
    // 作业面板用：中文标题与所属领域 id / 短码随作业行一并返回（跳转与展示不再二次查询）。
    expect(jobs[0].paperTitleZh).toBeNull();
    expect(jobs[0].domainId).toBe(domainId);
    expect(typeof jobs[0].domainCode).toBe("string");
  });

  it("paperBriefs 只返回请求的论文标题与领域；空入参不查库", async () => {
    const domainId = await makeDomain();
    const a = await repo.createPaper({ domainId, title: "Alpha" });
    await repo.updatePaper(a.id, { titleZh: "甲" });
    const b = await repo.createPaper({ domainId, title: "Beta" });
    await repo.createPaper({ domainId, title: "Gamma" });

    const briefs = await repo.paperBriefs([a.id, b.id, a.id, "missing"]);
    expect(briefs.map((brief) => brief.title).sort()).toEqual(["Alpha", "Beta"]);
    const alpha = briefs.find((brief) => brief.id === a.id);
    expect(alpha).toMatchObject({ titleZh: "甲", domainId });
    expect(alpha?.domainName).toContain("MM-01");
    expect(await repo.paperBriefs([])).toEqual([]);
  });

  it("stats 汇总论文与作业计数", async () => {
    const domainId = await makeDomain();
    const p1 = await repo.createPaper({ domainId, title: "p1" });
    const p2 = await repo.createPaper({ domainId, title: "p2" });
    await repo.setReadingStatus(p1.id, "read");
    await repo.updatePaper(p2.id, { codeOpenSource: "open" });
    const job = await repo.createJob(p1.id, "prepareMeta", "p");
    const stats = await repo.stats();
    expect(stats).toEqual({ total: 2, read: 1, openSource: 1, queued: 1, running: 0 });
    await repo.updateJob(job.id, { status: "running" });
    expect((await repo.stats()).running).toBe(1);
  });
});

describe("MinerU 状态与解析文本", () => {
  it("setMineruState 把凭据指纹和提交状态一起写入，省略时保留，新建论文为 NULL", async () => {
    const domainId = await makeDomain();
    const plain = "token-plain-sk-old";
    const paper = await repo.createPaper({ domainId, pdfPath: "/tmp/attention.pdf" });
    expect((await repo.getPaper(paper.id))!.mineruCredFingerprint).toBeNull();
    await repo.setMineruState(paper.id, {
      status: "submitted",
      provider: "api",
      docRef: "batch-1",
      parseIds: ["1"],
      credFingerprint: "pf-cred-v1:abc",
    });
    let row = (await repo.getPaper(paper.id))!;
    expect(row.mineruStatus).toBe("submitted");
    expect(row.mineruProvider).toBe("api");
    expect(row.mineruDocRef).toBe("batch-1");
    expect(row.mineruCredFingerprint).toBe("pf-cred-v1:abc");
    expect(row.mineruCredFingerprint).not.toContain(plain);
    const stored = await holder.engine!.select<{ mineru_cred_fingerprint: string | null }>(
      "SELECT mineru_cred_fingerprint FROM papers WHERE id = ?",
      [paper.id],
    );
    expect(stored[0]?.mineru_cred_fingerprint).toBe("pf-cred-v1:abc");
    expect(stored[0]?.mineru_cred_fingerprint ?? "").not.toContain(plain);
    await repo.setMineruState(paper.id, { status: "parsing" });
    row = (await repo.getPaper(paper.id))!;
    expect(row.mineruStatus).toBe("parsing");
    expect(row.mineruCredFingerprint).toBe("pf-cred-v1:abc");
    await repo.setMineruState(paper.id, { credFingerprint: null, provider: null, docRef: null, parseIds: [] });
    row = (await repo.getPaper(paper.id))!;
    expect(row.mineruCredFingerprint).toBeNull();
    expect(row.mineruProvider).toBeNull();
  });

  it("取消和认领完成只改写仍在排队、已提交或解析中的论文", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId, pdfPath: "/tmp/attention.pdf" });
    await repo.setMineruState(paper.id, { status: "parsing", provider: "local", docRef: "doc-1" });
    expect(await repo.setMineruState(paper.id, { status: "cancelled" })).toBe(true);
    expect(await repo.setMineruState(paper.id, { status: "done", error: null })).toBe(false);
    expect((await repo.getPaper(paper.id))!.mineruStatus).toBe("cancelled");

    const other = await repo.createPaper({ domainId, pdfPath: "/tmp/other.pdf" });
    await repo.setMineruState(other.id, { status: "submitted", provider: "api", docRef: "batch-1" });
    const job = await repo.createJob(other.id, "mineruParse", "prompt");
    await repo.updateJob(job.id, { status: "running", startedAt: "2024-01-01T00:00:00.000Z" });
    expect(await repo.revertDoneJob(job.id)).toBe(false);
    expect(await repo.updateJob(job.id, { status: "done", finishedAt: "2024-01-01T00:00:01.000Z" })).toBe(true);
    expect(await repo.setMineruState(other.id, { status: "cancelled" })).toBe(true);
    expect(await repo.setMineruState(other.id, { status: "done", error: null })).toBe(false);
    expect((await repo.getPaper(other.id))!.mineruStatus).toBe("cancelled");
    expect(await repo.revertDoneJob(job.id)).toBe(true);
    expect(await repo.jobStatus(job.id)).toBe("cancelled");
    expect(await repo.revertDoneJob(job.id)).toBe(false);
  });

  it("setMineruState patch 各字段并保留未指定字段（含 provider）", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    await repo.setMineruState(paper.id, { status: "submitted", docRef: "abc123", parseIds: ["7", "8"], provider: "ssh" });
    let row = (await repo.getPaper(paper.id))!;
    expect(row.mineruStatus).toBe("submitted");
    expect(row.mineruDocRef).toBe("abc123");
    expect(row.mineruParseIds).toEqual(["7", "8"]);
    expect(row.mineruProvider).toBe("ssh");
    // 只 patch status：其余字段保留。
    await repo.setMineruState(paper.id, { status: "parsing" });
    row = (await repo.getPaper(paper.id))!;
    expect(row.mineruStatus).toBe("parsing");
    expect(row.mineruDocRef).toBe("abc123");
    expect(row.mineruProvider).toBe("ssh");
  });

  it("saveParsedMarkdown + listPendingMineru + listReadyForMeta", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId, pdfPath: "/x/a.pdf" });
    await repo.setMineruState(paper.id, { status: "parsing", docRef: "d", provider: "local" });
    expect(await repo.listPendingMineru()).toEqual([paper.id]);
    expect(await repo.listReadyForMeta()).toEqual([]);

    await repo.saveParsedMarkdown(paper.id, "# 全文 markdown");
    await repo.setMineruState(paper.id, { status: "done" });
    expect(await repo.listPendingMineru()).toEqual([]);
    // 有解析文本且未补全元数据 → 进入待补全列表。
    expect(await repo.listReadyForMeta()).toEqual([paper.id]);
    await repo.applyPreparedMeta(paper.id, {
      title: "t",
      titleZh: null,
      abstract: "",
      year: null,
      venue: null,
      doi: null,
      arxivId: null,
      authors: [],
      labs: [],
      codeOpenSource: "unknown",
      codeURL: null,
      projectPage: null,
      pdfURL: null,
      tags: [],
    });
    expect(await repo.listReadyForMeta()).toEqual([]);
  });

  it("空 markdown 不进待补全列表", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    await repo.saveParsedMarkdown(paper.id, "");
    expect(await repo.listReadyForMeta()).toEqual([]);
  });
});

describe("deletePaper / deleteDomain 级联", () => {
  it("删除论文清理关联行，authors 全局行保留", async () => {
    const engine = holder.engine!;
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    await repo.replaceAuthors(paper.id, [{ name: "Carol", affiliation: "MIT" }]);
    await repo.saveParsedMarkdown(paper.id, "# md");
    await repo.createJob(paper.id, "prepareMeta", "p");
    await repo.deletePaper(paper.id);
    expect(await repo.getPaper(paper.id)).toBeNull();
    for (const table of ["notes", "paper_parse", "llm_jobs", "paper_authors"]) {
      const rows = await engine.select<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE paper_id = ?`, [paper.id]);
      expect(Number(rows[0]?.c)).toBe(0);
    }
    const authors = await engine.select<{ c: number }>("SELECT COUNT(*) AS c FROM authors");
    expect(Number(authors[0]?.c)).toBe(1);
  });

  it("删除领域连带删除其论文", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    await repo.deleteDomain(domainId);
    expect(await repo.getPaper(paper.id)).toBeNull();
    expect(await repo.listDomains()).toEqual([]);
  });

  it("deletePapers：只删勾选集合，级联清理与单删一致，空数组不动数据", async () => {
    const engine = holder.engine!;
    const domainId = await makeDomain();
    const a = await repo.createPaper({ domainId, title: "a" });
    const b = await repo.createPaper({ domainId, title: "b" });
    await repo.createPaper({ domainId, title: "c" });
    await repo.saveParsedMarkdown(b.id, "# b");

    await repo.deletePapers([]);
    expect((await repo.listPapers(domainId)).length).toBe(3);

    await repo.deletePapers([a.id, b.id]);
    const rest = await repo.listPapers(domainId);
    expect(rest.map((p) => p.title)).toEqual(["c"]);
    expect(await repo.getPaper(a.id)).toBeNull();
    const parseRows = await engine.select<{ c: number }>(
      "SELECT COUNT(*) AS c FROM paper_parse WHERE paper_id = ?",
      [b.id],
    );
    expect(Number(parseRows[0]?.c)).toBe(0);
  });
});

describe("domain 短码可选（仅名称必填）", () => {
  it("短码留空时按排序自动生成 D-01 递增", async () => {
    const a = await repo.createDomain({ name: "多模态", code: "" });
    expect(a.code).toBe("D-01");
    const b = await repo.createDomain({ name: "检索", code: "  " });
    expect(b.code).toBe("D-02");
  });

  it("填写短码时规范化为大写并去空白", async () => {
    const d = await repo.createDomain({ name: "x", code: " mm-3 " });
    expect(d.code).toBe("MM-3");
  });

  it("编辑时清空短码保留原值，不写入空串", async () => {
    const d = await repo.createDomain({ name: "x", code: "MM-9" });
    await repo.updateDomain(d.id, { name: "y", code: "", summary: "" });
    const domains = await repo.listDomains();
    expect(domains.find((x) => x.id === d.id)?.code).toBe("MM-9");
  });
});

describe("deleteDomain（领域删除完整性）", () => {
  it("删除领域时论文与全部关联数据（笔记/解析/作业/作者关联/作者行）一并移除，其他领域不受影响", async () => {
    const a = await repo.createDomain({ name: "领域A", code: "A-1" });
    const b = await repo.createDomain({ name: "领域B", code: "B-1" });
    const pa = await repo.createPaper({ domainId: a.id, pdfPath: "/x/a.pdf" });
    const pb = await repo.createPaper({ domainId: b.id, pdfPath: "/x/b.pdf" });
    await repo.saveParsedMarkdown(pa.id, "# 全文");
    await repo.createJob(pa.id, "mineruParse", "/x/a.pdf");
    await repo.replaceAuthors(pa.id, [{ name: "张三" }, { name: "李四" }]);
    await repo.replaceAuthors(pb.id, [{ name: "王五" }]);

    await repo.deleteDomain(a.id);

    expect(await repo.listPapers(a.id)).toHaveLength(0);
    expect(await repo.listPapers(b.id)).toHaveLength(1);
    const engine = holder.engine!;
    const counts = async (sql: string) =>
      (await engine.select<{ n: number }>(sql))[0]?.n ?? 0;
    expect(await counts("SELECT COUNT(*) AS n FROM papers WHERE domain_id = '" + a.id + "'")).toBe(0);
    expect(await counts("SELECT COUNT(*) AS n FROM paper_parse WHERE paper_id = '" + pa.id + "'")).toBe(0);
    expect(await counts("SELECT COUNT(*) AS n FROM llm_jobs WHERE paper_id = '" + pa.id + "'")).toBe(0);
    expect(await counts("SELECT COUNT(*) AS n FROM paper_authors WHERE paper_id = '" + pa.id + "'")).toBe(0);
    expect(await counts("SELECT COUNT(*) AS n FROM notes WHERE paper_id = '" + pa.id + "'")).toBe(0);
    // 孤儿作者清理：张三/李四随领域删除，王五保留
    const names = await engine.select<{ name: string }>("SELECT name FROM authors ORDER BY name");
    expect(names.map((row) => row.name)).toEqual(["王五"]);
  });

  it("删除中途失败时整体回滚，领域与论文保持原状", async () => {
    const a = await repo.createDomain({ name: "领域A", code: "A-1" });
    await repo.createPaper({ domainId: a.id, pdfPath: "/x/a.pdf" });
    const engine = holder.engine!;
    // 破坏一张关联表，让删除序列在中途失败
    await engine.execute("DROP TABLE notes");

    await expect(repo.deleteDomain(a.id)).rejects.toThrow();

    // 回滚后论文与领域仍在
    expect(await repo.listPapers(a.id)).toHaveLength(1);
    const domains = await repo.listDomains();
    expect(domains.some((d) => d.id === a.id)).toBe(true);
  });
});

describe("列级写入与条件写入", () => {
  it("updatePaper 只写 patch 里的列，只改被改字段的来源与徽章", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    await repo.applyPreparedMeta(
      paper.id,
      {
        title: "库标题", titleZh: null, abstract: "库摘要", year: 2020, venue: "库期刊", doi: null, arxivId: null,
        authors: [], labs: [], codeOpenSource: "unknown", codeURL: null, projectPage: null, pdfURL: null, tags: [],
        fieldProviders: { title: "crossref", abstract: "crossref", year: "crossref", venue: "crossref" },
      },
      false,
      { source: "api" },
    );
    const before = (await repo.getPaper(paper.id))!;
    await repo.updatePaper(paper.id, { venue: "手填期刊" }, true);
    const after = (await repo.getPaper(paper.id))!;
    expect(after.venue).toBe("手填期刊");
    expect(after.fieldSources?.venue).toBe("user");
    expect(after.fieldProviders?.venue).toBeUndefined();
    expect(after.fieldSources?.title).toBe("api");
    expect(after.fieldProviders?.title).toBe("crossref");
    expect(after.metaRev).toBe((before.metaRev ?? 0) + 1);
    expect(after.title).toBe("库标题");
  });

  it("updatePaper：用户手填的无协议链接补上 https://", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    await repo.updatePaper(paper.id, { codeUrl: "github.com/foo/bar" }, true);
    expect((await repo.getPaper(paper.id))!.codeUrl).toBe("https://github.com/foo/bar");
  });

  it("updatePaper 对不存在的论文报错", async () => {
    await expect(repo.updatePaper("missing", { title: "x" }, true)).rejects.toThrow("论文不存在");
  });

  it("replaceLinkIf：链接已被改过或归用户时不写", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    await repo.applyPreparedMeta(
      paper.id,
      {
        title: "", titleZh: null, abstract: "", year: null, venue: null, doi: null, arxivId: null, authors: [], labs: [],
        codeOpenSource: "unknown", codeURL: "https://github.com/ai/guess", projectPage: null, pdfURL: null, tags: [],
      },
      false,
      { source: "llm" },
    );
    // 期望值对不上（校验期间被改过）：不写
    expect(await repo.replaceLinkIf(paper.id, "codeUrl", "https://github.com/other", null)).toBe(false);
    // 用户改成自己的链接：之后基于旧值的清除不生效
    await repo.updatePaper(paper.id, { codeUrl: "https://github.com/me/real" }, true);
    expect(await repo.replaceLinkIf(paper.id, "codeUrl", "https://github.com/me/real", null)).toBe(false);
    expect((await repo.getPaper(paper.id))!.codeUrl).toBe("https://github.com/me/real");
  });

  it("replaceLinkIf：值未变且不归用户时清除并去掉来源", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    await repo.applyPreparedMeta(
      paper.id,
      {
        title: "", titleZh: null, abstract: "", year: null, venue: null, doi: null, arxivId: null, authors: [], labs: [],
        codeOpenSource: "unknown", codeURL: "https://github.com/ai/guess", projectPage: null, pdfURL: null, tags: [],
      },
      false,
      { source: "llm" },
    );
    const stored = (await repo.getPaper(paper.id))!.codeUrl;
    expect(await repo.replaceLinkIf(paper.id, "codeUrl", stored, null)).toBe(true);
    const after = (await repo.getPaper(paper.id))!;
    expect(after.codeUrl).toBeNull();
    expect(after.fieldSources?.codeUrl).toBeUndefined();
  });

  it("applyDraftedNotes：作业开始后被改过的块（版本号变了）整块保留", async () => {
    const domainId = await makeDomain();
    const paper = await repo.createPaper({ domainId });
    const started = (await repo.getPaper(paper.id))!;
    const revs = Object.fromEntries(Object.entries(started.notes).map(([kind, block]) => [kind, block.rev ?? 0]));
    // 请求进行中用户保存了「总结」
    await repo.updateNote(paper.id, "summary", "我在请求期间写的总结");
    const kept = await repo.applyDraftedNotes(
      paper.id,
      { remarks: "r", summary: "AI 总结", highlights: "h", weaknesses: "w", implications: "i" },
      true,
      revs,
    );
    expect(kept).toEqual(["summary"]);
    const detail = (await repo.getPaper(paper.id))!;
    expect(detail.notes.summary.content).toBe("我在请求期间写的总结");
    expect(detail.notes.summary.source).toBe("manual");
    expect(detail.notes.highlights.content).toBe("h");
    expect(detail.notes.highlights.source).toBe("llm");
  });
});

describe("手动添加的 PDF 进文库", () => {
  it("已在库中的 PDF 不重复建档", async () => {
    const domainId = await makeDomain();
    await repo.createPaper({ domainId, pdfPath: "library/1-a.pdf", pdfOriginalPath: "/home/u/a.pdf" });
    await expect(repo.adoptManualPdf("/home/u/a.pdf")).rejects.toThrow("已在库中");
    await expect(repo.adoptManualPdf("library/1-a.pdf")).rejects.toThrow("已在库中");
    // 浏览器预览没有文库目录：原样返回
    expect(await repo.adoptManualPdf("/home/u/b.pdf")).toEqual({ libraryPath: "/home/u/b.pdf", originalPath: "/home/u/b.pdf" });
  });
});
