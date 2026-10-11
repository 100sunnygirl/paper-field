import type { SqlEngine } from "./engine";

/**
 * Ordered schema versions. `PRAGMA user_version` is the only migration cursor.
 * Each step may add columns, backfill, and replace triggers (DROP + CREATE).
 * `CREATE TRIGGER IF NOT EXISTS` is not used for the final bodies: an existing
 * database would otherwise keep a stale trigger forever.
 */
export const SCHEMA_VERSION = 3;

export const DOMAIN_CASCADE_SQL = `CREATE TRIGGER pf_domain_cascade
    AFTER DELETE ON domains
    BEGIN
      DELETE FROM papers WHERE domain_id = OLD.id;
      DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM paper_authors);
    END`;

export const PAPER_CASCADE_SQL = `CREATE TRIGGER pf_paper_cascade
    AFTER DELETE ON papers
    BEGIN
      DELETE FROM llm_jobs WHERE paper_id = OLD.id;
      DELETE FROM paper_parse WHERE paper_id = OLD.id;
      DELETE FROM notes WHERE paper_id = OLD.id;
      DELETE FROM paper_authors WHERE paper_id = OLD.id;
    END`;

/**
 * One UPDATE of papers.author_replace rewrites that paper's authors.
 * The trigger body runs inside the same statement, so a failure rolls the
 * delete and the inserts back together. plugin-sql does not keep a transaction
 * open across statements, and sql.js rejects INSERT/DELETE inside a CTE.
 * A global authors row is reused only when affiliation and lab are both set
 * and match. Blank affiliation never collapses two same-name coauthors.
 */
export const AUTHOR_REPLACE_SQL = `CREATE TRIGGER pf_author_replace
    AFTER UPDATE OF author_replace ON papers
    WHEN NEW.author_replace IS NOT NULL
    BEGIN
      DELETE FROM pf_author_stage WHERE paper_id = NEW.id;
      INSERT INTO pf_author_stage (paper_id, ord, new_id, name, affiliation, lab, corresponding)
      SELECT NEW.id,
             CAST(j.key AS INTEGER),
             lower(hex(randomblob(16))),
             TRIM(json_extract(j.value, '$.name')),
             NULLIF(TRIM(IFNULL(json_extract(j.value, '$.affiliation'), '')), ''),
             NULLIF(TRIM(IFNULL(json_extract(j.value, '$.lab'), '')), ''),
             CASE WHEN json_extract(j.value, '$.corresponding') IN (1, '1', 'true') THEN 1 ELSE 0 END
        FROM json_each(NEW.author_replace) AS j
       WHERE TRIM(IFNULL(json_extract(j.value, '$.name'), '')) != '';
      DELETE FROM paper_authors WHERE paper_id = NEW.id;
      INSERT INTO authors (id, name, name_zh, affiliation, lab, homepage, orcid)
      SELECT s.new_id, s.name, NULL, s.affiliation, s.lab, NULL, NULL
        FROM pf_author_stage s
       WHERE s.paper_id = NEW.id
         AND NOT (
           IFNULL(s.affiliation, '') != ''
           AND IFNULL(s.lab, '') != ''
           AND EXISTS (
             SELECT 1 FROM authors a
              WHERE lower(a.name) = lower(s.name)
                AND IFNULL(TRIM(a.affiliation), '') = IFNULL(s.affiliation, '')
                AND IFNULL(TRIM(a.lab), '') = IFNULL(s.lab, '')
           )
         );
      INSERT INTO paper_authors (paper_id, author_id, sort_order, is_corresponding)
      SELECT s.paper_id,
             COALESCE(
               (SELECT a.id FROM authors a
                 WHERE IFNULL(s.affiliation, '') != ''
                   AND IFNULL(s.lab, '') != ''
                   AND lower(a.name) = lower(s.name)
                   AND IFNULL(TRIM(a.affiliation), '') = IFNULL(s.affiliation, '')
                   AND IFNULL(TRIM(a.lab), '') = IFNULL(s.lab, '')
                 LIMIT 1),
               s.new_id
             ),
             s.ord,
             s.corresponding
        FROM pf_author_stage s
       WHERE s.paper_id = NEW.id;
      DELETE FROM pf_author_stage WHERE paper_id = NEW.id;
      UPDATE papers SET author_replace = NULL WHERE id = NEW.id;
    END`;

const BASE_TABLES = [
  `CREATE TABLE IF NOT EXISTS domains (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    summary TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS papers (
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
    mineru_status TEXT,
    mineru_parse_id INTEGER,
    mineru_doc_ref TEXT,
    mineru_error TEXT,
    mineru_parse_ids TEXT NOT NULL DEFAULT '[]',
    mineru_provider TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    labs TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS paper_parse (
    paper_id TEXT PRIMARY KEY,
    markdown TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS authors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_zh TEXT,
    affiliation TEXT,
    lab TEXT,
    homepage TEXT,
    orcid TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS paper_authors (
    paper_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    is_corresponding INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (paper_id, author_id)
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    user_edited INTEGER NOT NULL DEFAULT 0,
    revised_at TEXT,
    UNIQUE(paper_id, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS llm_jobs (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt TEXT,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_papers_domain ON papers(domain_id)`,
  `CREATE INDEX IF NOT EXISTS idx_papers_status ON papers(reading_status)`,
  `CREATE INDEX IF NOT EXISTS idx_papers_updated ON papers(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_status ON llm_jobs(status)`,
  `CREATE INDEX IF NOT EXISTS idx_authors_name ON authors(name)`,
  `CREATE INDEX IF NOT EXISTS idx_papers_pdf_path ON papers(pdf_path)`,
];

/** Columns that older CREATE TABLE bodies may lack. Definition includes the name. */
const V1_PAPER_COLUMNS: Array<[string, string]> = [
  ["pdf_path", "pdf_path TEXT"],
  ["user_meta_touched", "user_meta_touched INTEGER NOT NULL DEFAULT 0"],
  ["mineru_status", "mineru_status TEXT"],
  ["mineru_parse_id", "mineru_parse_id INTEGER"],
  ["mineru_doc_ref", "mineru_doc_ref TEXT"],
  ["mineru_error", "mineru_error TEXT"],
  ["mineru_parse_ids", "mineru_parse_ids TEXT NOT NULL DEFAULT '[]'"],
  ["mineru_provider", "mineru_provider TEXT"],
];

async function columnExists(engine: SqlEngine, table: string, name: string): Promise<boolean> {
  const rows = await engine.select<{ name: string }>(
    `SELECT name FROM pragma_table_info('${table}') WHERE name = ?`,
    [name],
  );
  return rows.length > 0;
}

async function addColumn(engine: SqlEngine, table: string, name: string, definition: string): Promise<void> {
  if (await columnExists(engine, table, name)) return;
  await engine.execute(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

async function migrateV1(engine: SqlEngine): Promise<void> {
  for (const statement of BASE_TABLES) {
    await engine.execute(statement);
  }
  for (const [name, definition] of V1_PAPER_COLUMNS) {
    await addColumn(engine, "papers", name, definition);
  }
  await engine.execute("DROP TRIGGER IF EXISTS pf_domain_cascade");
  await engine.execute("DROP TRIGGER IF EXISTS pf_paper_cascade");
  await engine.execute(DOMAIN_CASCADE_SQL);
  await engine.execute(PAPER_CASCADE_SQL);
}

async function migrateV2(engine: SqlEngine): Promise<void> {
  await addColumn(engine, "papers", "field_sources", "field_sources TEXT NOT NULL DEFAULT '{}'");
  await addColumn(engine, "papers", "meta_confidence", "meta_confidence REAL");
  await addColumn(engine, "papers", "meta_rev", "meta_rev INTEGER NOT NULL DEFAULT 0");
  await addColumn(engine, "papers", "pdf_original_path", "pdf_original_path TEXT");
  await backfillFieldSources(engine);
}

interface LegacyPaperSourceRow {
  id: string;
  title: string;
  title_zh: string | null;
  abstract: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxiv_id: string | null;
  pdf_url: string | null;
  code_url: string | null;
  code_open_source: string | null;
  project_page: string | null;
  tags: string | null;
  labs: string | null;
  user_meta_touched: number | null;
}

/** Existing non-empty fields become user-owned or model-owned so the first lookup does not clobber a library. */
async function backfillFieldSources(engine: SqlEngine): Promise<void> {
  const rows = await engine.select<LegacyPaperSourceRow>(
    `SELECT id, title, title_zh, abstract, year, venue, doi, arxiv_id, pdf_url, code_url,
            code_open_source, project_page, tags, labs, user_meta_touched
       FROM papers`,
  );
  for (const row of rows) {
    const src = row.user_meta_touched ? "user" : "llm";
    const sources: Record<string, string> = {};
    if (row.title?.trim() && row.title !== "未命名论文") sources.title = src;
    if (row.title_zh?.trim()) sources.titleZh = src;
    if (row.abstract?.trim()) sources.abstract = src;
    if (row.year != null) sources.year = src;
    if (row.venue?.trim()) sources.venue = src;
    if (row.doi?.trim()) sources.doi = src;
    if (row.arxiv_id?.trim()) sources.arxivId = src;
    if (row.pdf_url?.trim()) sources.pdfUrl = src;
    if (row.code_url?.trim()) sources.codeUrl = src;
    if (row.project_page?.trim()) sources.projectPage = src;
    if (row.code_open_source && row.code_open_source !== "unknown") sources.codeOpenSource = src;
    if (row.tags && row.tags !== "[]") sources.tags = src;
    if (row.labs && row.labs !== "[]") sources.labs = src;
    const authors = await engine.select<{ c: number }>(
      "SELECT COUNT(*) AS c FROM paper_authors WHERE paper_id = ?",
      [row.id],
    );
    if (Number(authors[0]?.c ?? 0) > 0) sources.authors = src;
    if (Object.keys(sources).length) {
      await engine.execute("UPDATE papers SET field_sources = ? WHERE id = ?", [JSON.stringify(sources), row.id]);
    }
  }
}

/**
 * paper_authors was keyed by (paper_id, author_id), so two coauthors who share
 * a name and have no affiliation collapsed into one row. Position in the paper
 * is the key; global author reuse happens only in the write path.
 * Triggers are replaced again so a later edit of their bodies reaches existing databases.
 */
async function migrateV3(engine: SqlEngine): Promise<void> {
  // Triggers reference paper_authors. Drop them before the table is rebuilt,
  // or SQLite refuses the DROP with "no such table: paper_authors".
  await engine.execute("DROP TRIGGER IF EXISTS pf_domain_cascade");
  await engine.execute("DROP TRIGGER IF EXISTS pf_paper_cascade");
  const tables = await engine.select<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'paper_authors'",
  );
  if (tables.length) {
    await engine.execute("DROP TABLE IF EXISTS paper_authors_next");
    await engine.execute(
      `CREATE TABLE paper_authors_next (
        paper_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        is_corresponding INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (paper_id, sort_order)
      )`,
    );
    await engine.execute(
      `INSERT INTO paper_authors_next (paper_id, author_id, sort_order, is_corresponding)
       SELECT paper_id, author_id,
              ROW_NUMBER() OVER (PARTITION BY paper_id ORDER BY sort_order, author_id) - 1,
              is_corresponding
         FROM paper_authors`,
    );
    await engine.execute("DROP TABLE paper_authors");
    await engine.execute("ALTER TABLE paper_authors_next RENAME TO paper_authors");
  }
  await engine.execute(DOMAIN_CASCADE_SQL);
  await engine.execute(PAPER_CASCADE_SQL);
  await addColumn(engine, "papers", "author_replace", "author_replace TEXT");
  await engine.execute(`CREATE TABLE IF NOT EXISTS pf_author_stage (
    paper_id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    new_id TEXT NOT NULL,
    name TEXT NOT NULL,
    affiliation TEXT,
    lab TEXT,
    corresponding INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (paper_id, ord)
  )`);
  await engine.execute("DROP TRIGGER IF EXISTS pf_author_replace");
  await engine.execute(AUTHOR_REPLACE_SQL);
}

const MIGRATIONS: Array<{ version: number; up: (engine: SqlEngine) => Promise<void> }> = [
  { version: 1, up: migrateV1 },
  { version: 2, up: migrateV2 },
  { version: 3, up: migrateV3 },
];

export async function userVersion(engine: SqlEngine): Promise<number> {
  const rows = await engine.select<{ user_version: number }>("PRAGMA user_version");
  return Number(rows[0]?.user_version ?? 0);
}

export async function tableExists(engine: SqlEngine, name: string): Promise<boolean> {
  const rows = await engine.select<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name],
  );
  return rows.length > 0;
}

/** Run every migration newer than `fromVersion`, then stamp user_version. */
export async function runMigrations(engine: SqlEngine, fromVersion: number): Promise<void> {
  for (const migration of MIGRATIONS) {
    if (migration.version <= fromVersion) continue;
    await migration.up(engine);
    await engine.execute(`PRAGMA user_version = ${migration.version}`);
  }
}
