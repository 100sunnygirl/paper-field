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
  `CREATE INDEX IF NOT EXISTS idx_papers_domain ON papers(domain_id)`,
  `CREATE INDEX IF NOT EXISTS idx_papers_status ON papers(reading_status)`,
  `CREATE INDEX IF NOT EXISTS idx_papers_updated ON papers(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_status ON llm_jobs(status)`,
  `CREATE INDEX IF NOT EXISTS idx_authors_name ON authors(name)`,
];

export const PAPER_MIGRATIONS = [
  "ALTER TABLE papers ADD COLUMN pdf_path TEXT",
  "ALTER TABLE papers ADD COLUMN user_meta_touched INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE papers ADD COLUMN mineru_status TEXT",
  "ALTER TABLE papers ADD COLUMN mineru_parse_id INTEGER",
  "ALTER TABLE papers ADD COLUMN mineru_doc_ref TEXT",
  "ALTER TABLE papers ADD COLUMN mineru_error TEXT",
  "ALTER TABLE papers ADD COLUMN mineru_parse_ids TEXT NOT NULL DEFAULT '[]'",
];
