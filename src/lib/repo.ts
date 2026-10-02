import { getEngine, type SqlEngine } from "./engine";
import { seedIfEmpty } from "./seed";
import type {
  Domain,
  DraftedNotes,
  FieldStats,
  JobStatus,
  JobType,
  Lab,
  MineruStatus,
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
  pdf_path: string | null;
  code_url: string | null;
  code_open_source: OpenSource;
  project_page: string | null;
  reading_status: ReadingStatus;
  read_at: string | null;
  llm_prepared_at: string | null;
  notes_drafted_by_llm: number;
  user_notes_touched: number;
  user_meta_touched: number;
  mineru_status: MineruStatus | null;
  mineru_parse_id: number | null;
  mineru_doc_ref: string | null;
  mineru_error: string | null;
  mineru_parse_ids: string | null;
  mineru_provider?: string | null;
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

// 三种模式（现场 / 归档 / 入库）与跨域搜索共用的匹配条件：
// 标题、中文标题、摘要、期刊、DOI、arXiv、标签、实验室 JSON 文本 + 作者名。
const PAPER_SEARCH_MATCH_SQL = `(
            p.title LIKE ? OR IFNULL(p.title_zh,'') LIKE ? OR IFNULL(p.abstract,'') LIKE ?
            OR IFNULL(p.venue,'') LIKE ? OR IFNULL(p.doi,'') LIKE ? OR IFNULL(p.arxiv_id,'') LIKE ?
            OR p.tags LIKE ? OR p.labs LIKE ?
            OR EXISTS (
              SELECT 1 FROM paper_authors pa JOIN authors a ON a.id = pa.author_id
               WHERE pa.paper_id = p.id AND a.name LIKE ?
            )
          )`;

function searchParams(like: string): unknown[] {
  return [like, like, like, like, like, like, like, like, like];
}

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
    pdfPath: row.pdf_path,
    codeUrl: row.code_url,
    codeOpenSource: row.code_open_source,
    projectPage: row.project_page,
    readingStatus: row.reading_status,
    readAt: row.read_at,
    llmPreparedAt: row.llm_prepared_at,
    notesDraftedByLlm: Boolean(row.notes_drafted_by_llm),
    userNotesTouched: Boolean(row.user_notes_touched),
    userMetaTouched: Boolean(row.user_meta_touched),
    mineruStatus: asMineruStatus(row.mineru_status),
    mineruParseId: row.mineru_parse_id == null ? null : String(row.mineru_parse_id),
    mineruDocRef: row.mineru_doc_ref,
    mineruError: row.mineru_error,
    // 旧库存的是数字数组，官方 API 时代统一归一为字符串（doclib 数字 id 字符串化）。
    mineruParseIds: parseJsonArray<string>(row.mineru_parse_ids, []).map((id) => String(id)),
    mineruProvider: row.mineru_provider ?? null,
    tags: parseJsonArray<string>(row.tags, []),
    labs: parseJsonArray<Lab>(row.labs, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function titleFromPdf(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? "";
  const title = base.replace(/\.pdf$/i, "").trim();
  return title || "Untitled paper";
}

/** 短码规范化：大写；留空时按排序号自动生成 D-01 递增。 */
function domainCodeOf(raw: string, sortOrder: number): string {
  const code = raw.trim().toUpperCase();
  return code || `D-${String(sortOrder).padStart(2, "0")}`;
}

function asMineruStatus(value: string | null): MineruStatus | null {
  if (
    value === "queued" ||
    value === "submitted" ||
    value === "parsing" ||
    value === "done" ||
    value === "error" ||
    value === "cancelled"
  ) {
    return value;
  }
  return null;
}

function textField(prev: string, next: string | null | undefined, locked: boolean): string {
  const incoming = next?.trim() ? next.trim() : prev;
  if (locked && prev.trim()) return prev;
  return incoming;
}

function nullableField(prev: string | null, next: string | null | undefined, locked: boolean): string | null {
  const incoming = next?.trim() ? next.trim() : prev;
  if (locked && prev?.trim()) return prev;
  return incoming;
}

function yearField(prev: number | null, next: number | null | undefined, locked: boolean): number | null {
  const incoming = typeof next === "number" && Number.isFinite(next) ? next : prev;
  if (locked && prev != null) return prev;
  return incoming;
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
    // 应用上次退出（崩溃 / 强杀）时残留的 queued/running 作业永远不会自行结束，
    // 会把状态栏钉在「作业运行中」并把论文钉在入库模式；启动时统一清扫为 error。
    await engine.execute(
      `UPDATE llm_jobs SET status = 'error', error = '应用上次退出，作业中断', finished_at = ?
        WHERE status IN ('queued','running')`,
      [nowIso()],
    );
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
    const sortOrder = (existing[0]?.max_order ?? 0) + 1;
    const domain: Domain = {
      id: uid(),
      name: input.name.trim(),
      // 短码可选：留空时按排序自动生成（D-01 递增），保证界面恒有短码可显示。
      code: domainCodeOf(input.code, sortOrder),
      summary: input.summary?.trim() || null,
      sortOrder,
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
    const code = domainCodeOf(input.code, 0);
    // 编辑时清空短码 → 保留原短码而不是写空串，列表/标题处恒有值。
    let effectiveCode = code;
    if (!input.code.trim()) {
      const rows = await engine.select<{ code: string }>("SELECT code FROM domains WHERE id = ?", [id]);
      effectiveCode = rows[0]?.code ?? code;
    }
    await engine.execute("UPDATE domains SET name = ?, code = ?, summary = ? WHERE id = ?", [
      input.name.trim(),
      effectiveCode,
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
          AND ${PAPER_SEARCH_MATCH_SQL}
        ORDER BY p.created_at DESC`,
      [domainId, ...searchParams(like)],
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
        WHERE ${PAPER_SEARCH_MATCH_SQL}
        ORDER BY p.updated_at DESC`,
      searchParams(like),
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
      clauses.push(PAPER_SEARCH_MATCH_SQL);
      params.push(...searchParams(like));
    }
    const rows = await engine.select<PaperRow>(
      `${PAPER_LIST_SQL} WHERE ${clauses.join(" AND ")} ORDER BY IFNULL(p.read_at, p.updated_at) DESC`,
      params,
    );
    return rows.map(mapListItem);
  },

  async listIntake(search = ""): Promise<PaperListItem[]> {
    const engine = await getEngine();
    const q = search.trim();
    if (!q) {
      const rows = await engine.select<PaperRow>(
        `${PAPER_LIST_SQL}
          WHERE p.reading_status != 'read'
             OR EXISTS (SELECT 1 FROM llm_jobs j WHERE j.paper_id = p.id AND j.status IN ('queued','running'))
          ORDER BY p.created_at DESC`,
      );
      return rows.map(mapListItem);
    }
    const like = `%${q}%`;
    const rows = await engine.select<PaperRow>(
      `${PAPER_LIST_SQL}
        WHERE (p.reading_status != 'read'
           OR EXISTS (SELECT 1 FROM llm_jobs j WHERE j.paper_id = p.id AND j.status IN ('queued','running')))
          AND ${PAPER_SEARCH_MATCH_SQL}
        ORDER BY p.created_at DESC`,
      searchParams(like),
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
    const parsed = await engine.select<{ markdown: string }>(
      "SELECT markdown FROM paper_parse WHERE paper_id = ?",
      [id],
    );
    return {
      ...paper,
      parsedMarkdown: parsed[0]?.markdown ?? "",
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

  async pdfPaths(): Promise<string[]> {
    const engine = await getEngine();
    const rows = await engine.select<{ pdf_path: string }>(
      "SELECT pdf_path FROM papers WHERE pdf_path IS NOT NULL AND pdf_path != ''",
    );
    return rows.map((row) => row.pdf_path);
  },

  async importLocalPdfs(
    domainId: string,
    paths: string[],
  ): Promise<{ created: Paper[]; skipped: string[] }> {
    const created: Paper[] = [];
    const skipped: string[] = [];
    const known = new Set(await this.pdfPaths());
    for (const path of paths) {
      if (known.has(path)) {
        skipped.push(path);
        continue;
      }
      const paper = await this.createPaper({ domainId, pdfPath: path });
      known.add(path);
      created.push(paper);
    }
    return { created, skipped };
  },

  async createPaper(input: { domainId: string; pdfPath?: string; title?: string }): Promise<Paper> {
    const engine = await getEngine();
    const at = nowIso();
    const pdfPath = input.pdfPath?.trim() || null;
    const title = input.title?.trim() || (pdfPath ? titleFromPdf(pdfPath) : "") || "未命名论文";
    const paper: Paper = {
      id: uid(),
      domainId: input.domainId,
      title,
      titleZh: null,
      abstract: "",
      year: null,
      venue: null,
      doi: null,
      arxivId: null,
      pdfUrl: null,
      pdfPath,
      codeUrl: null,
      codeOpenSource: "unknown",
      projectPage: null,
      readingStatus: "unread",
      readAt: null,
      llmPreparedAt: null,
      notesDraftedByLlm: false,
      userNotesTouched: false,
      userMetaTouched: false,
      mineruStatus: null,
      mineruParseId: null,
      mineruDocRef: null,
      mineruError: null,
      mineruParseIds: [],
      mineruProvider: null,
      tags: [],
      labs: [],
      createdAt: at,
      updatedAt: at,
    };
    await engine.execute(
      `INSERT INTO papers (
        id, domain_id, title, title_zh, abstract, year, venue, doi, arxiv_id, pdf_url, pdf_path,
        code_url, code_open_source, project_page, reading_status, read_at, llm_prepared_at,
        notes_drafted_by_llm, user_notes_touched, user_meta_touched, mineru_parse_ids, tags, labs, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, '', NULL, NULL, NULL, NULL, NULL, ?, NULL, 'unknown', NULL, 'unread', NULL, NULL, 0, 0, 0, '[]', '[]', '[]', ?, ?)`,
      [paper.id, paper.domainId, paper.title, paper.pdfPath, at, at],
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
    touchMeta = false,
  ): Promise<void> {
    const engine = await getEngine();
    const current = await engine.select<PaperRow>("SELECT * FROM papers WHERE id = ?", [id]);
    if (!current[0]) throw new Error("论文不存在");
    const next = mapPaper(current[0]);
    const merged = {
      ...next,
      ...patch,
      updatedAt: nowIso(),
      userMetaTouched: touchMeta ? true : next.userMetaTouched,
    };
    await engine.execute(
      `UPDATE papers SET
        domain_id = ?, title = ?, title_zh = ?, abstract = ?, year = ?, venue = ?, doi = ?,
        arxiv_id = ?, pdf_url = ?, code_url = ?, code_open_source = ?, project_page = ?,
        tags = ?, labs = ?, user_meta_touched = ?, updated_at = ?
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
        merged.userMetaTouched ? 1 : 0,
        merged.updatedAt,
        id,
      ],
    );
  },

  async setReadingStatus(id: string, status: ReadingStatus): Promise<void> {
    const engine = await getEngine();
    const at = nowIso();
    // read → reading → read 的往返不应把最初标记已读的时间覆盖成新时间：
    // 已读取历史值（无则记现在），在读保留历史值，未读清空。
    const rows = await engine.select<PaperRow>("SELECT * FROM papers WHERE id = ?", [id]);
    const prev = rows[0];
    const readAt =
      status === "read"
        ? prev?.read_at ?? at
        : status === "reading"
          ? prev?.read_at ?? null
          : null;
    await engine.execute(
      "UPDATE papers SET reading_status = ?, read_at = ?, updated_at = ? WHERE id = ?",
      [status, readAt, at, id],
    );
  },

  async deletePaper(id: string): Promise<void> {
    const engine = await getEngine();
    await engine.execute("DELETE FROM llm_jobs WHERE paper_id = ?", [id]);
    await engine.execute("DELETE FROM paper_parse WHERE paper_id = ?", [id]);
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
    touchMeta = false,
  ): Promise<void> {
    const engine = await getEngine();
    await engine.execute("DELETE FROM paper_authors WHERE paper_id = ?", [paperId]);
    let order = 0;
    for (const author of authors) {
      const name = author.name.trim();
      if (!name) continue;
      const incomingAffiliation = author.affiliation?.trim() || null;
      const incomingLab = author.lab?.trim() || null;
      // 只复用「名字 + 机构 + 实验室」完全一致（或双方均为空）的既有行；
      // 不一致时新插一行，绝不 UPDATE 全局 authors 行——
      // 否则改 A 论文作者机构会改写 B 论文的同名作者。
      const found = await engine.select<{ id: string }>(
        `SELECT id FROM authors
          WHERE lower(name) = lower(?)
            AND IFNULL(TRIM(affiliation), '') = ?
            AND IFNULL(TRIM(lab), '') = ?
          LIMIT 1`,
        [name, incomingAffiliation ?? "", incomingLab ?? ""],
      );
      const authorId = found[0]?.id ?? uid();
      if (!found[0]) {
        await engine.execute(
          `INSERT INTO authors (id, name, name_zh, affiliation, lab, homepage, orcid)
           VALUES (?, ?, NULL, ?, ?, NULL, NULL)`,
          [authorId, name, incomingAffiliation, incomingLab],
        );
      }
      await engine.execute(
        `INSERT OR REPLACE INTO paper_authors (paper_id, author_id, sort_order, is_corresponding)
         VALUES (?, ?, ?, ?)`,
        [paperId, authorId, order, author.isCorresponding ? 1 : 0],
      );
      order += 1;
    }
    await engine.execute(
      "UPDATE papers SET updated_at = ?, user_meta_touched = CASE WHEN ? = 1 THEN 1 ELSE user_meta_touched END WHERE id = ?",
      [nowIso(), touchMeta ? 1 : 0, paperId],
    );
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

  async applyPreparedMeta(paperId: string, meta: PreparedMeta, overwrite = false): Promise<void> {
    const engine = await getEngine();
    const current = await engine.select<PaperRow>("SELECT * FROM papers WHERE id = ?", [paperId]);
    if (!current[0]) throw new Error("论文不存在");
    const prev = mapPaper(current[0]);
    const locked = prev.userMetaTouched && !overwrite;
    const open: OpenSource = ["unknown", "open", "closed", "request"].includes(meta.codeOpenSource)
      ? meta.codeOpenSource
      : "unknown";
    const authorCount = await engine.select<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM paper_authors WHERE paper_id = ?",
      [paperId],
    );
    await engine.execute(
      `UPDATE papers SET
        title = ?, title_zh = ?, abstract = ?, year = ?, venue = ?, doi = ?, arxiv_id = ?,
        pdf_url = ?, code_url = ?, code_open_source = ?, project_page = ?, tags = ?, labs = ?,
        llm_prepared_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        textField(prev.title, meta.title, locked),
        nullableField(prev.titleZh, meta.titleZh, locked),
        textField(prev.abstract, meta.abstract, locked),
        yearField(prev.year, meta.year, locked),
        nullableField(prev.venue, meta.venue, locked),
        nullableField(prev.doi, meta.doi, locked),
        nullableField(prev.arxivId, meta.arxivId, locked),
        nullableField(prev.pdfUrl, meta.pdfURL, locked),
        nullableField(prev.codeUrl, meta.codeURL, locked),
        locked && prev.codeOpenSource !== "unknown" ? prev.codeOpenSource : open,
        nullableField(prev.projectPage, meta.projectPage, locked),
        JSON.stringify(locked && prev.tags.length ? prev.tags : (meta.tags ?? prev.tags)),
        JSON.stringify(locked && prev.labs.length ? prev.labs : (meta.labs ?? prev.labs)),
        nowIso(),
        nowIso(),
        paperId,
      ],
    );
    const authors = Number(authorCount[0]?.cnt ?? 0);
    if (meta.authors?.length && (!locked || authors === 0)) {
      await this.replaceAuthors(paperId, meta.authors, false);
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

  async setMineruState(
    id: string,
    patch: {
      status?: MineruStatus | null;
      parseId?: string | null;
      docRef?: string | null;
      error?: string | null;
      parseIds?: string[];
      provider?: string | null;
    },
  ): Promise<void> {
    const engine = await getEngine();
    const rows = await engine.select<PaperRow>("SELECT * FROM papers WHERE id = ?", [id]);
    if (!rows[0]) return;
    const prev = mapPaper(rows[0]);
    await engine.execute(
      `UPDATE papers SET mineru_status = ?, mineru_parse_id = ?, mineru_doc_ref = ?, mineru_error = ?, mineru_parse_ids = ?, mineru_provider = ?, updated_at = ? WHERE id = ?`,
      [
        patch.status === undefined ? prev.mineruStatus : patch.status,
        patch.parseId === undefined ? prev.mineruParseId : patch.parseId,
        patch.docRef === undefined ? prev.mineruDocRef : patch.docRef,
        patch.error === undefined ? prev.mineruError : patch.error,
        JSON.stringify(patch.parseIds === undefined ? prev.mineruParseIds : patch.parseIds),
        patch.provider === undefined ? (rows[0].mineru_provider ?? null) : patch.provider,
        nowIso(),
        id,
      ],
    );
  },

  async saveParsedMarkdown(id: string, markdown: string): Promise<void> {
    const engine = await getEngine();
    const at = nowIso();
    await engine.execute(
      `INSERT INTO paper_parse (paper_id, markdown, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(paper_id) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at`,
      [id, markdown, at],
    );
    await engine.execute("UPDATE papers SET updated_at = ? WHERE id = ?", [at, id]);
  },

  async listPendingMineru(): Promise<string[]> {
    const engine = await getEngine();
    const rows = await engine.select<{ id: string }>(
      `SELECT id FROM papers
        WHERE pdf_path IS NOT NULL AND pdf_path != ''
          AND mineru_status IN ('queued', 'submitted', 'parsing')
        ORDER BY updated_at ASC`,
    );
    return rows.map((row) => row.id);
  },

  /** 解析失败的论文（供 INTAKE 页批量重试）；跨领域，按失败时间先后排序。 */
  async listFailedMineru(): Promise<string[]> {
    const engine = await getEngine();
    const rows = await engine.select<{ id: string }>(
      `SELECT id FROM papers
        WHERE pdf_path IS NOT NULL AND pdf_path != '' AND mineru_status = 'error'
        ORDER BY updated_at ASC`,
    );
    return rows.map((row) => row.id);
  },

  async listReadyForMeta(): Promise<string[]> {
    const engine = await getEngine();
    const rows = await engine.select<{ id: string }>(
      `SELECT p.id FROM papers p
         JOIN paper_parse m ON m.paper_id = p.id
        WHERE p.llm_prepared_at IS NULL AND m.markdown != ''
        ORDER BY p.updated_at ASC`,
    );
    return rows.map((row) => row.id);
  },
};
