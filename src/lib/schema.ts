export const SCHEMA_STATEMENTS = [
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
    domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
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
    tags TEXT NOT NULL DEFAULT '[]',
    labs TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS paper_parse (
    paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
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
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL,
    is_corresponding INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (paper_id, author_id)
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    user_edited INTEGER NOT NULL DEFAULT 0,
    revised_at TEXT,
    UNIQUE(paper_id, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS llm_jobs (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
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
  // 级联删除触发器：DELETE domains / papers 单语句即原子清空全部关联行并扫孤儿作者。
  // 为什么不用 BEGIN…COMMIT 事务（0.2.8 方案）：Tauri 端 plugin-sql 底层是 sqlx 连接池
  // （Pool::connect，默认 max 10），每条 execute 独立取连接，BEGIN/语句/COMMIT 会落在
  // 不同连接上；失败时 ROLLBACK 错位被吞，把池连接留在「未提交事务 + 持锁」状态，此后
  // 所有写入报 cannot start a transaction within a transaction / database is locked
  // （app-log.json 2026-10-03 实录）。为什么不用表上已有的 FK ON DELETE CASCADE：
  // foreign_keys 是每连接 PRAGMA，池化下无法保证每条连接都开启。触发器属于数据库
  // 本体、不依赖任何 PRAGMA，单语句自带原子性（中途报错自动回滚整条语句）。
  // 孤儿作者清扫只放在域级联的末尾（不挂在 pf_paper_cascade，更不挂 paper_authors
  // 的 DELETE 触发器）：deletePaper 按既有契约保留 authors 全局行（repo.test
  // 「删除论文清理关联行，authors 全局行保留」）；replaceAuthors 也会先删后插同一
  // 论文的 paper_authors，挂在那会把跨论文复用的 authors 行误删。域删除时统一清扫
  // 与旧版 sweepOrphanAuthors 语义一致（顺带回收历史 deletePaper 遗留的孤儿）。
  `CREATE TRIGGER IF NOT EXISTS pf_domain_cascade
    AFTER DELETE ON domains
    BEGIN
      DELETE FROM papers WHERE domain_id = OLD.id;
      DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM paper_authors);
    END`,
  `CREATE TRIGGER IF NOT EXISTS pf_paper_cascade
    AFTER DELETE ON papers
    BEGIN
      DELETE FROM llm_jobs WHERE paper_id = OLD.id;
      DELETE FROM paper_parse WHERE paper_id = OLD.id;
      DELETE FROM notes WHERE paper_id = OLD.id;
      DELETE FROM paper_authors WHERE paper_id = OLD.id;
    END`,
];

export const PAPER_MIGRATIONS = [
  "ALTER TABLE papers ADD COLUMN pdf_path TEXT",
  "ALTER TABLE papers ADD COLUMN user_meta_touched INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE papers ADD COLUMN mineru_status TEXT",
  "ALTER TABLE papers ADD COLUMN mineru_parse_id INTEGER",
  "ALTER TABLE papers ADD COLUMN mineru_doc_ref TEXT",
  "ALTER TABLE papers ADD COLUMN mineru_error TEXT",
  "ALTER TABLE papers ADD COLUMN mineru_parse_ids TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE papers ADD COLUMN mineru_provider TEXT",
];
