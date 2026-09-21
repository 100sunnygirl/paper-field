import { getEngine, type SqlEngine } from "./engine";
import { seedIfEmpty } from "./seed";
import type {
  Domain,
  DraftedNotes,
  FieldStats,
  JobStatus,
  JobType,
  Lab,
  LlmJob,
  NoteBlock,
  NoteKind,
  OpenSource,
  Paper,
  PaperDetail,
  PaperListItem,
  PreparedMeta,
  ReadingStatus,
} from "./types";
import { NOTE_KINDS } from "./types";
import { nowIso, parseJsonArray, uid } from "./util";

interface DomainRow {
  id: string;
  name: string;
  code: string;
  summary: string | null;
  sort_order: number;
  created_at: string;
}

interface PaperRow {
  id: string;
  domain_id: string;
  title: string;
  title_zh: string | null;
  abstract: string;
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxiv_id: string | null;
  pdf_url: string | null;
  code_url: string | null;
  code_open_source: OpenSource;
  project_page: string | null;
  reading_status: ReadingStatus;
  read_at: string | null;
  llm_prepared_at: string | null;
  notes_drafted_by_llm: number;
  user_notes_touched: number;
  tags: string;
  labs: string;
  created_at: string;
  updated_at: string;
  first_author?: string | null;
  author_count?: number;
  domain_name?: string;
  domain_code?: string;
}

interface AuthorRow {
  id: string;
  name: string;
  name_zh: string | null;
  affiliation: string | null;
  lab: string | null;
  homepage: string | null;
  orcid: string | null;
  sort_order: number;
  is_corresponding: number;
}

interface NoteRow {
  id: string;
  paper_id: string;
  kind: NoteKind;
  content: string;
  source: "manual" | "llm";
  user_edited: number;
  revised_at: string | null;
}

interface JobRow {
  id: string;
  paper_id: string;
  type: JobType;
  status: JobStatus;
  prompt: string | null;
  result_json: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  paper_title?: string;
  domain_name?: string;
}

const PAPER_LIST_SQL = `
  SELECT p.*,
         d.name AS domain_name,
         d.code AS domain_code,
         (SELECT a.name FROM paper_authors pa
            JOIN authors a ON a.id = pa.author_id
           WHERE pa.paper_id = p.id
           ORDER BY pa.sort_order ASC LIMIT 1) AS first_author,
         (SELECT COUNT(*) FROM paper_authors pa WHERE pa.paper_id = p.id) AS author_count
    FROM papers p
    JOIN domains d ON d.id = p.domain_id
`;

function mapDomain(row: DomainRow): Domain {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    summary: row.summary,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

function mapPaper(row: PaperRow): Paper {
  return {
    id: row.id,
    domainId: row.domain_id,
    title: row.title,
    titleZh: row.title_zh,
    abstract: row.abstract ?? "",
    year: row.year,
    venue: row.venue,
    doi: row.doi,
    arxivId: row.arxiv_id,
    pdfUrl: row.pdf_url,
    codeUrl: row.code_url,
    codeOpenSource: row.code_open_source,
    projectPage: row.project_page,
    readingStatus: row.reading_status,
    readAt: row.read_at,
    llmPreparedAt: row.llm_prepared_at,
    notesDraftedByLlm: Boolean(row.notes_drafted_by_llm),
    userNotesTouched: Boolean(row.user_notes_touched),
    tags: parseJsonArray<string>(row.tags, []),
    labs: parseJsonArray<Lab>(row.labs, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapListItem(row: PaperRow): PaperListItem {
  return {
    ...mapPaper(row),
    firstAuthor: row.first_author ?? null,
    authorCount: Number(row.author_count ?? 0),
    domainName: row.domain_name ?? "",
    domainCode: row.domain_code ?? "",
  };
}

async function emptyNotes(engine: SqlEngine, paperId: string, at: string): Promise<void> {
  for (const kind of NOTE_KINDS) {
    await engine.execute(
      `INSERT OR IGNORE INTO notes (id, paper_id, kind, content, source, user_edited, revised_at)
       VALUES (?, ?, ?, '', 'manual', 0, ?)`,
      [uid(), paperId, kind, at],
    );
  }
}

export const repo = {
  async init(): Promise<void> {
    const engine = await getEngine();
    await seedIfEmpty(engine);
  },

  async listDomains(): Promise<Domain[]> {
    const engine = await getEngine();
    const rows = await engine.select<DomainRow>(
      "SELECT * FROM domains ORDER BY sort_order ASC, created_at ASC",
    );
    return rows.map(mapDomain);
  },

  async getDomain(id: string): Promise<Domain | null> {
    const engine = await getEngine();
    const rows = await engine.select<DomainRow>("SELECT * FROM domains WHERE id = ?", [id]);
    return rows[0] ? mapDomain(rows[0]) : null;
  },

  async createDomain(input: { name: string; code: string; summary?: string }): Promise<Domain> {
    const engine = await getEngine();
    const existing = await engine.select<{ max_order: number | null }>(
      "SELECT MAX(sort_order) AS max_order FROM domains",
    );
    const domain: Domain = {
      id: uid(),
      name: input.name.trim(),
      code: input.code.trim().toUpperCase(),
      summary: input.summary?.trim() || null,
      sortOrder: (existing[0]?.max_order ?? 0) + 1,
      createdAt: nowIso(),
    };
    await engine.execute(
      "INSERT INTO domains (id, name, code, summary, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [domain.id, domain.name, domain.code, domain.summary, domain.sortOrder, domain.createdAt],
    );
    return domain;
  },

  async updateDomain(id: string, input: { name: string; code: string; summary?: string }): Promise<void> {
    const engine = await getEngine();
    await engine.execute("UPDATE domains SET name = ?, code = ?, summary = ? WHERE id = ?", [
      input.name.trim(),
      input.code.trim().toUpperCase(),
      input.summary?.trim() || null,
      id,
    ]);
  },

  async deleteDomain(id: string): Promise<void> {
    const engine = await getEngine();
    const papers = await engine.select<{ id: string }>("SELECT id FROM papers WHERE domain_id = ?", [id]);
    for (const paper of papers) {
      await this.deletePaper(paper.id);
    }
    await engine.execute("DELETE FROM domains WHERE id = ?", [id]);
  },

  async listPapers(domainId: string, search = ""): Promise<PaperListItem[]> {
    const engine = await getEngine();
    const q = search.trim();
    if (!q) {
      const rows = await engine.select<PaperRow>(
        `${PAPER_LIST_SQL} WHERE p.domain_id = ? ORDER BY p.created_at DESC`,
        [domainId],
      );
      return rows.map(mapListItem);
    }
    const like = `%${q}%`;
    const rows = await engine.select<PaperRow>(
      `${PAPER_LIST_SQL}
        WHERE p.domain_id = ?
          AND (
            p.title LIKE ? OR IFNULL(p.title_zh,'') LIKE ? OR IFNULL(p.abstract,'') LIKE ?
            OR IFNULL(p.venue,'') LIKE ? OR IFNULL(p.doi,'') LIKE ? OR IFNULL(p.arxiv_id,'') LIKE ?
            OR p.tags LIKE ?
            OR EXISTS (
              SELECT 1 FROM paper_authors pa JOIN authors a ON a.id = pa.author_id
               WHERE pa.paper_id = p.id AND a.name LIKE ?
            )
          )
        ORDER BY p.created_at DESC`,
      [domainId, like, like, like, like, like, like, like, like],
    );
    return rows.map(mapListItem);
  },

  async searchAll(search: string): Promise<PaperListItem[]> {
    const engine = await getEngine();
    const q = search.trim();
    if (!q) return [];
    const like = `%${q}%`;
    const rows = await engine.select<PaperRow>(
      `${PAPER_LIST_SQL}
        WHERE p.title LIKE ? OR IFNULL(p.title_zh,'') LIKE ? OR IFNULL(p.abstract,'') LIKE ?
          OR IFNULL(p.venue,'') LIKE ? OR p.tags LIKE ?
          OR EXISTS (
            SELECT 1 FROM paper_authors pa JOIN authors a ON a.id = pa.author_id
             WHERE pa.paper_id = p.id AND a.name LIKE ?
          )
        ORDER BY p.updated_at DESC`,
      [like, like, like, like, like, like],
    );
    return rows.map(mapListItem);
  },

  async listArchive(filter: {
    search?: string;
    openSource?: OpenSource | "all";
  }): Promise<PaperListItem[]> {
    const engine = await getEngine();
    const clauses = ["p.reading_status = 'read'"];
    const params: unknown[] = [];
    if (filter.openSource && filter.openSource !== "all") {
      clauses.push("p.code_open_source = ?");
      params.push(filter.openSource);
    }
    if (filter.search?.trim()) {
      const like = `%${filter.search.trim()}%`;
      clauses.push(
        `(p.title LIKE ? OR IFNULL(p.title_zh,'') LIKE ? OR IFNULL(p.venue,'') LIKE ? OR p.labs LIKE ?)`,
      );
      params.push(like, like, like, like);
    }
    const rows = await engine.select<PaperRow>(
      `${PAPER_LIST_SQL} WHERE ${clauses.join(" AND ")} ORDER BY IFNULL(p.read_at, p.updated_at) DESC`,
      params,
    );
    return rows.map(mapListItem);
  },

  async listIntake(): Promise<PaperListItem[]> {
    const engine = await getEngine();
    const rows = await engine.select<PaperRow>(
      `${PAPER_LIST_SQL}
        WHERE p.reading_status != 'read'
           OR EXISTS (SELECT 1 FROM llm_jobs j WHERE j.paper_id = p.id AND j.status IN ('queued','running'))
        ORDER BY p.created_at DESC`,
    );
    return rows.map(mapListItem);
  },

  async getPaper(id: string): Promise<PaperDetail | null> {
    const engine = await getEngine();
    const papers = await engine.select<PaperRow>("SELECT * FROM papers WHERE id = ?", [id]);
    if (!papers[0]) return null;
    const paper = mapPaper(papers[0]);
    const domain = await this.getDomain(paper.domainId);
    if (!domain) return null;
    const authors = await engine.select<AuthorRow>(
      `SELECT a.*, pa.sort_order, pa.is_corresponding
         FROM paper_authors pa JOIN authors a ON a.id = pa.author_id
        WHERE pa.paper_id = ? ORDER BY pa.sort_order ASC`,
      [id],
    );
    const notesRows = await engine.select<NoteRow>(
      "SELECT * FROM notes WHERE paper_id = ?",
      [id],
    );
    const notes = {} as Record<NoteKind, NoteBlock>;
    for (const kind of NOTE_KINDS) {
      const row = notesRows.find((n) => n.kind === kind);
      notes[kind] = row
        ? {
            id: row.id,
            paperId: row.paper_id,
            kind: row.kind,
            content: row.content,
            source: row.source,
            userEdited: Boolean(row.user_edited),
            revisedAt: row.revised_at,
          }
        : {
            id: uid(),
            paperId: id,
            kind,
            content: "",
            source: "manual",
            userEdited: false,
            revisedAt: null,
          };
    }
    return {
      ...paper,
      domain,
      authors: authors.map((row) => ({
        id: row.id,
        name: row.name,
        nameZh: row.name_zh,
        affiliation: row.affiliation,
        lab: row.lab,
        homepage: row.homepage,
        orcid: row.orcid,
        order: row.sort_order,
        isCorresponding: Boolean(row.is_corresponding),
      })),
      notes,
    };
  },

  async createPaper(input: {
    domainId: string;
    title?: string;
    arxivId?: string;
    doi?: string;
    pdfUrl?: string;
  }): Promise<Paper> {
    const engine = await getEngine();
    const at = nowIso();
    const title =
      input.title?.trim() ||
      input.arxivId?.trim() ||
      input.doi?.trim() ||
      input.pdfUrl?.trim() ||
      "Untitled paper";
    const paper: Paper = {
      id: uid(),
      domainId: input.domainId,
      title,
      titleZh: null,
      abstract: "",
      year: null,
      venue: null,
      doi: input.doi?.trim() || null,
      arxivId: input.arxivId?.trim() || null,
      pdfUrl: input.pdfUrl?.trim() || null,
      codeUrl: null,
      codeOpenSource: "unknown",
      projectPage: null,
      readingStatus: "unread",
      readAt: null,
      llmPreparedAt: null,
      notesDraftedByLlm: false,
      userNotesTouched: false,
      tags: [],
      labs: [],
      createdAt: at,
      updatedAt: at,
    };
    await engine.execute(
      `INSERT INTO papers (
        id, domain_id, title, title_zh, abstract, year, venue, doi, arxiv_id, pdf_url,
        code_url, code_open_source, project_page, reading_status, read_at, llm_prepared_at,
        notes_drafted_by_llm, user_notes_touched, tags, labs, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, '', NULL, NULL, ?, ?, ?, NULL, 'unknown', NULL, 'unread', NULL, NULL, 0, 0, '[]', '[]', ?, ?)`,
      [paper.id, paper.domainId, paper.title, paper.doi, paper.arxivId, paper.pdfUrl, at, at],
    );
    await emptyNotes(engine, paper.id, at);
    return paper;
  },

  async updatePaper(
    id: string,
    patch: Partial<{
      title: string;
      titleZh: string | null;
      abstract: string;
      year: number | null;
      venue: string | null;
      doi: string | null;
      arxivId: string | null;
      pdfUrl: string | null;
      codeUrl: string | null;
      codeOpenSource: OpenSource;
      projectPage: string | null;
      tags: string[];
      labs: Lab[];
      domainId: string;
    }>,
  ): Promise<void> {
    const engine = await getEngine();
    const current = await engine.select<PaperRow>("SELECT * FROM papers WHERE id = ?", [id]);
    if (!current[0]) throw new Error("论文不存在");
    const next = mapPaper(current[0]);
    const merged = {
      ...next,
      ...patch,
      updatedAt: nowIso(),
    };
    await engine.execute(
      `UPDATE papers SET
        domain_id = ?, title = ?, title_zh = ?, abstract = ?, year = ?, venue = ?, doi = ?,
        arxiv_id = ?, pdf_url = ?, code_url = ?, code_open_source = ?, project_page = ?,
        tags = ?, labs = ?, updated_at = ?
       WHERE id = ?`,
      [
        merged.domainId,
        merged.title,
        merged.titleZh,
        merged.abstract,
        merged.year,
        merged.venue,
        merged.doi,
        merged.arxivId,
        merged.pdfUrl,
        merged.codeUrl,
        merged.codeOpenSource,
        merged.projectPage,
        JSON.stringify(merged.tags),
        JSON.stringify(merged.labs),
        merged.updatedAt,
        id,
      ],
    );
  },

  async setReadingStatus(id: string, status: ReadingStatus): Promise<void> {
    const engine = await getEngine();
    const at = nowIso();
    const readAt = status === "read" ? at : null;
    await engine.execute(
      "UPDATE papers SET reading_status = ?, read_at = ?, updated_at = ? WHERE id = ?",
      [status, readAt, at, id],
    );
  },

  async deletePaper(id: string): Promise<void> {
    const engine = await getEngine();
    await engine.execute("DELETE FROM llm_jobs WHERE paper_id = ?", [id]);
    await engine.execute("DELETE FROM notes WHERE paper_id = ?", [id]);
    await engine.execute("DELETE FROM paper_authors WHERE paper_id = ?", [id]);
    await engine.execute("DELETE FROM papers WHERE id = ?", [id]);
  },

  async replaceAuthors(
    paperId: string,
    authors: Array<{
      name: string;
      affiliation?: string | null;
      lab?: string | null;
      isCorresponding?: boolean;
    }>,
  ): Promise<void> {
    const engine = await getEngine();
    await engine.execute("DELETE FROM paper_authors WHERE paper_id = ?", [paperId]);
    let order = 0;
    for (const author of authors) {
      const name = author.name.trim();
      if (!name) continue;
      const found = await engine.select<{ id: string }>(
        "SELECT id FROM authors WHERE lower(name) = lower(?) LIMIT 1",
        [name],
      );
      const authorId = found[0]?.id ?? uid();
      if (!found[0]) {
        await engine.execute(
          `INSERT INTO authors (id, name, name_zh, affiliation, lab, homepage, orcid)
           VALUES (?, ?, NULL, ?, ?, NULL, NULL)`,
          [authorId, name, author.affiliation ?? null, author.lab ?? null],
        );
      } else {
        await engine.execute("UPDATE authors SET affiliation = ?, lab = ? WHERE id = ?", [
          author.affiliation ?? null,
          author.lab ?? null,
          authorId,
        ]);
      }
      await engine.execute(
        `INSERT OR REPLACE INTO paper_authors (paper_id, author_id, sort_order, is_corresponding)
         VALUES (?, ?, ?, ?)`,
        [paperId, authorId, order, author.isCorresponding ? 1 : 0],
      );
      order += 1;
    }
    await engine.execute("UPDATE papers SET updated_at = ? WHERE id = ?", [nowIso(), paperId]);
  },

  async updateNote(
    paperId: string,
    kind: NoteKind,
    content: string,
    source: "manual" | "llm" = "manual",
    markUserEdited = true,
  ): Promise<void> {
    const engine = await getEngine();
    const at = nowIso();
    const existing = await engine.select<NoteRow>(
      "SELECT * FROM notes WHERE paper_id = ? AND kind = ?",
      [paperId, kind],
    );
    if (existing[0]) {
      await engine.execute(
        `UPDATE notes SET content = ?, source = CASE WHEN ? = 'llm' AND user_edited = 0 THEN 'llm' ELSE source END,
           user_edited = ?, revised_at = ? WHERE id = ?`,
        [content, source, markUserEdited ? 1 : existing[0].user_edited, at, existing[0].id],
      );
    } else {
      await engine.execute(
        `INSERT INTO notes (id, paper_id, kind, content, source, user_edited, revised_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uid(), paperId, kind, content, source, markUserEdited ? 1 : 0, at],
      );
    }
    if (markUserEdited) {
      await engine.execute(
        "UPDATE papers SET user_notes_touched = 1, updated_at = ? WHERE id = ?",
        [at, paperId],
      );
    } else {
      await engine.execute("UPDATE papers SET updated_at = ? WHERE id = ?", [at, paperId]);
    }
  },

  async applyPreparedMeta(paperId: string, meta: PreparedMeta): Promise<void> {
    const engine = await getEngine();
    const current = await engine.select<PaperRow>("SELECT * FROM papers WHERE id = ?", [paperId]);
    if (!current[0]) throw new Error("论文不存在");
    const prev = mapPaper(current[0]);
    const open: OpenSource = ["unknown", "open", "closed", "request"].includes(meta.codeOpenSource)
      ? meta.codeOpenSource
      : "unknown";
    await engine.execute(
      `UPDATE papers SET
        title = ?, title_zh = ?, abstract = ?, year = ?, venue = ?, doi = ?, arxiv_id = ?,
        pdf_url = ?, code_url = ?, code_open_source = ?, project_page = ?, tags = ?, labs = ?,
        llm_prepared_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        meta.title?.trim() || prev.title,
        meta.titleZh?.trim() || prev.titleZh,
        meta.abstract ?? prev.abstract,
        meta.year ?? prev.year,
        meta.venue ?? prev.venue,
        meta.doi ?? prev.doi,
        meta.arxivId ?? prev.arxivId,
        meta.pdfURL ?? prev.pdfUrl,
        meta.codeURL ?? prev.codeUrl,
        open,
        meta.projectPage ?? prev.projectPage,
        JSON.stringify(meta.tags ?? prev.tags),
        JSON.stringify(meta.labs ?? prev.labs),
        nowIso(),
        nowIso(),
        paperId,
      ],
    );
    if (meta.authors?.length) {
      await this.replaceAuthors(paperId, meta.authors);
    }
  },

  async applyDraftedNotes(paperId: string, notes: DraftedNotes, overwrite: boolean): Promise<void> {
    const engine = await getEngine();
    const paper = await engine.select<PaperRow>("SELECT * FROM papers WHERE id = ?", [paperId]);
    if (!paper[0]) throw new Error("论文不存在");
    if (paper[0].user_notes_touched && !overwrite) {
      throw new Error("NOTES_TOUCHED");
    }
    for (const kind of NOTE_KINDS) {
      await this.updateNote(paperId, kind, notes[kind] ?? "", "llm", false);
    }
    await engine.execute(
      "UPDATE papers SET notes_drafted_by_llm = 1, updated_at = ? WHERE id = ?",
      [nowIso(), paperId],
    );
  },

  async createJob(paperId: string, type: JobType, prompt: string): Promise<LlmJob> {
    const engine = await getEngine();
    const job: LlmJob = {
      id: uid(),
      paperId,
      type,
      status: "queued",
      prompt,
      resultJson: null,
      error: null,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
    };
    await engine.execute(
      `INSERT INTO llm_jobs (id, paper_id, type, status, prompt, result_json, error, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL)`,
      [job.id, job.paperId, job.type, job.status, job.prompt, job.createdAt],
    );
    return job;
  },

  async updateJob(
    id: string,
    patch: Partial<Pick<LlmJob, "status" | "resultJson" | "error" | "startedAt" | "finishedAt">>,
  ): Promise<void> {
    const engine = await getEngine();
    const rows = await engine.select<JobRow>("SELECT * FROM llm_jobs WHERE id = ?", [id]);
    if (!rows[0]) return;
    const next = { ...rows[0], ...{
      status: patch.status ?? rows[0].status,
      result_json: patch.resultJson ?? rows[0].result_json,
      error: patch.error ?? rows[0].error,
      started_at: patch.startedAt ?? rows[0].started_at,
      finished_at: patch.finishedAt ?? rows[0].finished_at,
    }};
    await engine.execute(
      `UPDATE llm_jobs SET status = ?, result_json = ?, error = ?, started_at = ?, finished_at = ? WHERE id = ?`,
      [next.status, next.result_json, next.error, next.started_at, next.finished_at, id],
    );
  },

  async listJobs(limit = 40): Promise<LlmJob[]> {
    const engine = await getEngine();
    const rows = await engine.select<JobRow>(
      `SELECT j.*, p.title AS paper_title, d.name AS domain_name
         FROM llm_jobs j
         JOIN papers p ON p.id = j.paper_id
         JOIN domains d ON d.id = p.domain_id
        ORDER BY j.created_at DESC LIMIT ?`,
      [limit],
    );
    return rows.map((row) => ({
      id: row.id,
      paperId: row.paper_id,
      type: row.type,
      status: row.status,
      prompt: row.prompt,
      resultJson: row.result_json,
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      paperTitle: row.paper_title,
      domainName: row.domain_name,
    }));
  },

  async activeJobsForPaper(paperId: string): Promise<LlmJob[]> {
    const jobs = await this.listJobs(80);
    return jobs.filter(
      (job) => job.paperId === paperId && (job.status === "queued" || job.status === "running"),
    );
  },

  async stats(): Promise<FieldStats> {
    const engine = await getEngine();
    const totals = await engine.select<{ total: number; read: number; open_source: number }>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN reading_status = 'read' THEN 1 ELSE 0 END) AS read,
         SUM(CASE WHEN code_open_source = 'open' THEN 1 ELSE 0 END) AS open_source
       FROM papers`,
    );
    const jobs = await engine.select<{ queued: number; running: number }>(
      `SELECT
         SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
       FROM llm_jobs`,
    );
    return {
      total: Number(totals[0]?.total ?? 0),
      read: Number(totals[0]?.read ?? 0),
      openSource: Number(totals[0]?.open_source ?? 0),
      queued: Number(jobs[0]?.queued ?? 0),
      running: Number(jobs[0]?.running ?? 0),
    };
  },

  async papersForExport(domainId: string): Promise<PaperDetail[]> {
    const papers = await this.listPapers(domainId);
    const details: PaperDetail[] = [];
    for (const paper of papers) {
      const detail = await this.getPaper(paper.id);
      if (detail) details.push(detail);
    }
    return details;
  },
};
