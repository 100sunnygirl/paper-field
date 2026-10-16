import { getEngine, type SqlEngine } from "./engine";
import { planPreparedMeta } from "./mergeMeta";
import { seedIfEmpty } from "./seed";
import type {
  Domain,
  DraftedNotes,
  FieldProviders,
  FieldSource,
  FieldSources,
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
  PaperBrief,
  PaperListItem,
  PreparedMeta,
  ReadingStatus,
} from "./types";
import { NOTE_KINDS } from "./types";
import { safeHttpUrl } from "./urls";
import { isTauri, nowIso, parseJsonArray, uid } from "./util";

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
  mineru_cred_fingerprint?: string | null;
  tags: string;
  labs: string;
  field_sources?: string | null;
  field_providers?: string | null;
  meta_confidence?: number | null;
  meta_rev?: number | null;
  pdf_original_path?: string | null;
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
  paper_title_zh?: string | null;
  domain_id?: string;
  domain_name?: string;
  domain_code?: string;
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
            p.title LIKE ? ESCAPE '\\' OR IFNULL(p.title_zh,'') LIKE ? ESCAPE '\\' OR IFNULL(p.abstract,'') LIKE ? ESCAPE '\\'
            OR IFNULL(p.venue,'') LIKE ? ESCAPE '\\' OR IFNULL(p.doi,'') LIKE ? ESCAPE '\\' OR IFNULL(p.arxiv_id,'') LIKE ? ESCAPE '\\'
            OR p.tags LIKE ? ESCAPE '\\' OR p.labs LIKE ? ESCAPE '\\'
            OR EXISTS (
              SELECT 1 FROM paper_authors pa JOIN authors a ON a.id = pa.author_id
               WHERE pa.paper_id = p.id AND a.name LIKE ? ESCAPE '\\'
            )
          )`;

/** `%q%` with LIKE wildcards escaped, for `LIKE ? ESCAPE '\\'`: a search for
 *  `50%` or `a_b` matches only that literal text. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

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
    fieldSources: parseFieldSources(row.field_sources),
    fieldProviders: parseFieldProviders(row.field_providers),
    metaConfidence: row.meta_confidence == null ? null : Number(row.meta_confidence),
    metaRev: Number(row.meta_rev ?? 0),
    pdfOriginalPath: row.pdf_original_path ?? null,
    mineruStatus: asMineruStatus(row.mineru_status),
    mineruParseId: row.mineru_parse_id == null ? null : String(row.mineru_parse_id),
    mineruDocRef: row.mineru_doc_ref,
    mineruError: row.mineru_error,
    // 旧库存的是数字数组，官方 API 时代统一归一为字符串（doclib 数字 id 字符串化）。
    mineruParseIds: parseJsonArray<string>(row.mineru_parse_ids, []).map((id) => String(id)),
    mineruProvider: row.mineru_provider ?? null,
    mineruCredFingerprint: row.mineru_cred_fingerprint ?? null,
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

function parseFieldSources(raw: string | null | undefined): FieldSources {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as FieldSources;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function parseFieldProviders(raw: string | null | undefined): FieldProviders {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as FieldProviders;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

const META_PATCH_KEYS = [
  "title",
  "titleZh",
  "abstract",
  "year",
  "venue",
  "doi",
  "arxivId",
  "pdfUrl",
  "codeUrl",
  "codeOpenSource",
  "projectPage",
  "tags",
  "labs",
] as const;

function withUserSources(prev: FieldSources, patch: Record<string, unknown>): FieldSources {
  const next: FieldSources = { ...prev };
  for (const key of META_PATCH_KEYS) {
    if (patch[key] !== undefined) next[key] = "user";
  }
  return next;
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

async function adoptPdf(source: string): Promise<{ libraryPath: string; originalPath: string }> {
  if (!isTauri()) return { libraryPath: source, originalPath: source };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<{ libraryPath: string; originalPath: string }>("import_pdf_to_library", { source });
}

async function emptyNotes(engine: SqlEngine, paperId: string, at: string): Promise<void> {  for (const kind of NOTE_KINDS) {
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
    // 整域删除原子性由 pf_domain_cascade → pf_paper_cascade 触发器在单语句内完成
    // （论文/笔记/解析/作业/作者关联一次清完、孤儿作者扫除），中途失败整条语句
    // 自动回滚，不留下「领域还在但论文没了」或「删了一半」的状态。
    // 不再用 BEGIN IMMEDIATE…COMMIT：plugin-sql 的 sqlx 连接池下各语句会落在不同
    // 连接上，事务错位曾把池连接留在持锁的未提交状态（详见 schema.ts 触发器注释）。
    const engine = await getEngine();
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
    const like = likePattern(q);
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
    const like = likePattern(q);
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
      const like = likePattern(filter.search.trim());
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
    const like = likePattern(q);
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
    const rows = await engine.select<{ path: string }>(
      `SELECT pdf_path AS path FROM papers WHERE pdf_path IS NOT NULL AND pdf_path != ''
       UNION
       SELECT pdf_original_path AS path FROM papers WHERE pdf_original_path IS NOT NULL AND pdf_original_path != ''`,
    );
    return rows.map((row) => row.path);
  },

  async importLocalPdfs(
    domainId: string,
    paths: string[],
  ): Promise<{ created: Paper[]; skipped: string[] }> {
    const created: Paper[] = [];
    const skipped: string[] = [];
    const known = new Set(await this.pdfPaths());
    for (const path of paths) {
      const adopted = await adoptPdf(path);
      if (known.has(path) || known.has(adopted.libraryPath) || known.has(adopted.originalPath)) {
        skipped.push(path);
        continue;
      }
      const paper = await this.createPaper({
        domainId,
        pdfPath: adopted.libraryPath,
        pdfOriginalPath: adopted.originalPath,
      });
      known.add(adopted.libraryPath);
      known.add(adopted.originalPath);
      created.push(paper);
    }
    return { created, skipped };
  },

  async createPaper(input: {
    domainId: string;
    pdfPath?: string;
    pdfOriginalPath?: string;
    title?: string;
    arxivId?: string;
    doi?: string;
    /** Manual intake: title / arXiv / DOI the user typed are user-owned. */
    userOwned?: boolean;
  }): Promise<Paper> {
    const engine = await getEngine();
    const at = nowIso();
    const pdfPath = input.pdfPath?.trim() || null;
    const explicitTitle = input.title?.trim() || "";
    const title = explicitTitle || (pdfPath ? titleFromPdf(pdfPath) : "") || "未命名论文";
    const arxivId = input.arxivId?.trim() || null;
    const doi = input.doi?.trim() || null;
    const sources: FieldSources = {};
    if (explicitTitle || input.userOwned) sources.title = "user";
    else if (pdfPath) sources.title = "llm";
    if (arxivId) sources.arxivId = "user";
    if (doi) sources.doi = "user";
    const userMetaTouched = Boolean(explicitTitle || input.userOwned || arxivId || doi);
    const paper: Paper = {
      id: uid(),
      domainId: input.domainId,
      title,
      titleZh: null,
      abstract: "",
      year: null,
      venue: null,
      doi,
      arxivId,
      pdfUrl: null,
      pdfPath,
      pdfOriginalPath: input.pdfOriginalPath?.trim() || null,
      codeUrl: null,
      codeOpenSource: "unknown",
      projectPage: null,
      readingStatus: "unread",
      readAt: null,
      llmPreparedAt: null,
      notesDraftedByLlm: false,
      userNotesTouched: false,
      userMetaTouched,
      fieldSources: sources,
      metaConfidence: null,
      metaRev: userMetaTouched ? 1 : 0,
      mineruStatus: null,
      mineruParseId: null,
      mineruDocRef: null,
      mineruError: null,
      mineruParseIds: [],
      mineruProvider: null,
      mineruCredFingerprint: null,
      tags: [],
      labs: [],
      createdAt: at,
      updatedAt: at,
    };
    await engine.execute(
      `INSERT INTO papers (
        id, domain_id, title, title_zh, abstract, year, venue, doi, arxiv_id, pdf_url, pdf_path,
        code_url, code_open_source, project_page, reading_status, read_at, llm_prepared_at,
        notes_drafted_by_llm, user_notes_touched, user_meta_touched, mineru_parse_ids, tags, labs,
        field_sources, meta_rev, pdf_original_path, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, '', NULL, NULL, ?, ?, NULL, ?, NULL, 'unknown', NULL, 'unread', NULL, NULL, 0, 0, ?, '[]', '[]', '[]', ?, ?, ?, ?, ?)`,
      [
        paper.id,
        paper.domainId,
        paper.title,
        paper.doi,
        paper.arxivId,
        paper.pdfPath,
        userMetaTouched ? 1 : 0,
        JSON.stringify(sources),
        paper.metaRev,
        paper.pdfOriginalPath,
        at,
        at,
      ],
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
    const sanitized = { ...patch };
    if (sanitized.pdfUrl !== undefined) sanitized.pdfUrl = safeHttpUrl(sanitized.pdfUrl);
    if (sanitized.codeUrl !== undefined) sanitized.codeUrl = safeHttpUrl(sanitized.codeUrl);
    if (sanitized.projectPage !== undefined) sanitized.projectPage = safeHttpUrl(sanitized.projectPage);
    const sources = touchMeta ? withUserSources(next.fieldSources ?? {}, sanitized) : (next.fieldSources ?? {});
    const providers: FieldProviders = { ...(next.fieldProviders ?? {}) };
    if (touchMeta) {
      for (const key of META_PATCH_KEYS) {
        if (sanitized[key as (typeof META_PATCH_KEYS)[number]] !== undefined) delete providers[key];
      }
    }
    const merged = {
      ...next,
      ...sanitized,
      updatedAt: nowIso(),
      userMetaTouched: touchMeta ? true : next.userMetaTouched,
      fieldSources: sources,
      fieldProviders: providers,
      metaRev: touchMeta ? (next.metaRev ?? 0) + 1 : (next.metaRev ?? 0),
    };
    await engine.execute(
      `UPDATE papers SET
        domain_id = ?, title = ?, title_zh = ?, abstract = ?, year = ?, venue = ?, doi = ?,
        arxiv_id = ?, pdf_url = ?, code_url = ?, code_open_source = ?, project_page = ?,
        tags = ?, labs = ?, user_meta_touched = ?, field_sources = ?, field_providers = ?, meta_rev = ?, updated_at = ?
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
        JSON.stringify(merged.fieldSources),
        JSON.stringify(merged.fieldProviders ?? {}),
        merged.metaRev,
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
    // 同 deleteDomain：单语句删除，级联清理由 pf_paper_cascade 触发器完成。
    const engine = await getEngine();
    await engine.execute("DELETE FROM papers WHERE id = ?", [id]);
  },

  async deletePapers(ids: string[]): Promise<void> {
    // 同 deletePaper（触发器级联），按 500 个分块：一条 IN (…) 的绑定参数
    // 不能超过 SQLite 的变量上限，整库勾选删除时单语句会炸。
    if (!ids.length) return;
    const engine = await getEngine();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(", ");
      await engine.execute(`DELETE FROM papers WHERE id IN (${placeholders})`, chunk);
    }
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
    expectedMetaRev: number | null = null,
  ): Promise<void> {
    const engine = await getEngine();
    const payload = JSON.stringify(
      authors
        .filter((author) => author.name?.trim())
        .map((author) => ({
          name: author.name.trim(),
          affiliation: author.affiliation?.trim() || "",
          lab: author.lab?.trim() || "",
          corresponding: author.isCorresponding ? 1 : 0,
        })),
    );
    // pf_author_replace runs inside this UPDATE, so the link delete and the
    // author inserts commit or roll back with it.
    await engine.execute(
      `UPDATE papers SET author_replace = ?, updated_at = ?,
         user_meta_touched = CASE WHEN ? = 1 THEN 1 ELSE user_meta_touched END,
         meta_rev = meta_rev + CASE WHEN ? = 1 THEN 1 ELSE 0 END,
         field_sources = CASE WHEN ? = 1
           THEN json_set(COALESCE(field_sources, '{}'), '$.authors', 'user')
           ELSE field_sources END
       WHERE id = ? AND (? IS NULL OR meta_rev = ?)`,
      [payload, nowIso(), touchMeta ? 1 : 0, touchMeta ? 1 : 0, touchMeta ? 1 : 0, paperId, expectedMetaRev, expectedMetaRev],
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

  async applyPreparedMeta(
    paperId: string,
    meta: PreparedMeta,
    overwrite = false,
    ctx?: { startedRev?: number; source?: FieldSource; jobId?: string; replaceApi?: boolean },
  ): Promise<void> {
    const engine = await getEngine();
    const source = ctx?.source ?? "llm";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (ctx?.jobId && (await this.jobStatus(ctx.jobId)) !== "running") return;
      const current = await engine.select<PaperRow>("SELECT * FROM papers WHERE id = ?", [paperId]);
      if (!current[0]) throw new Error("论文不存在");
      const prev = mapPaper(current[0]);
      const authorCount = await engine.select<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM paper_authors WHERE paper_id = ?",
        [paperId],
      );
      const plan = planPreparedMeta(
        {
          ...prev,
          fieldSources: prev.fieldSources ?? {},
          fieldProviders: prev.fieldProviders ?? {},
          metaRev: prev.metaRev ?? 0,
          authorCount: Number(authorCount[0]?.cnt ?? 0),
        },
        meta,
        overwrite,
        source,
        ctx?.startedRev,
        ctx?.replaceApi ?? false,
      );
      const at = nowIso();
      const changed = await engine.execute(
        `UPDATE papers SET
          title = ?, title_zh = ?, abstract = ?, year = ?, venue = ?, doi = ?, arxiv_id = ?,
          pdf_url = ?, code_url = ?, code_open_source = ?, project_page = ?, tags = ?, labs = ?,
          field_sources = ?, field_providers = ?, meta_confidence = COALESCE(?, meta_confidence),
          llm_prepared_at = CASE WHEN ? = 'llm' THEN ? ELSE llm_prepared_at END,
          updated_at = ?
         WHERE id = ? AND meta_rev = ?
           AND (? = '' OR EXISTS (SELECT 1 FROM llm_jobs WHERE id = ? AND status = 'running'))`,
        [
          plan.title,
          plan.titleZh,
          plan.abstract,
          plan.year,
          plan.venue,
          plan.doi,
          plan.arxivId,
          plan.pdfUrl,
          plan.codeUrl,
          plan.codeOpenSource,
          plan.projectPage,
          JSON.stringify(plan.tags),
          JSON.stringify(plan.labs),
          JSON.stringify(plan.fieldSources),
          JSON.stringify(plan.fieldProviders),
          plan.confidence,
          source,
          at,
          at,
          paperId,
          prev.metaRev ?? 0,
          ctx?.jobId ?? "",
          ctx?.jobId ?? "",
        ],
      );
      if (!changed) {
        if (ctx?.jobId && (await this.jobStatus(ctx.jobId)) !== "running") return;
        continue;
      }
      const after = await engine.select<{ meta_rev: number }>("SELECT meta_rev FROM papers WHERE id = ?", [paperId]);
      if (Number(after[0]?.meta_rev ?? 0) !== (prev.metaRev ?? 0)) continue;
      if (plan.replaceAuthors) await this.replaceAuthors(paperId, meta.authors, false, prev.metaRev ?? 0);
      return;
    }
  },

  async applyDraftedNotes(paperId: string, notes: DraftedNotes, overwrite: boolean): Promise<void> {
    const engine = await getEngine();
    const paper = await engine.select<PaperRow>("SELECT * FROM papers WHERE id = ?", [paperId]);
    if (!paper[0]) throw new Error("论文不存在");
    if (paper[0].user_notes_touched && !overwrite) {
      throw new Error("NOTES_TOUCHED");
    }
    const blocks = await engine.select<NoteRow>("SELECT * FROM notes WHERE paper_id = ?", [paperId]);
    for (const kind of NOTE_KINDS) {
      const block = blocks.find((row) => row.kind === kind);
      if (block?.user_edited && !overwrite) continue;
      const at = nowIso();
      if (block) {
        await engine.execute(
          `UPDATE notes SET content = ?, source = 'llm', user_edited = 0, revised_at = ? WHERE id = ?`,
          [notes[kind] ?? "", at, block.id],
        );
      } else {
        await engine.execute(
          `INSERT INTO notes (id, paper_id, kind, content, source, user_edited, revised_at)
           VALUES (?, ?, ?, ?, 'llm', 0, ?)`,
          [uid(), paperId, kind, notes[kind] ?? "", at],
        );
      }
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

  async jobStatus(id: string): Promise<JobStatus | null> {
    const engine = await getEngine();
    const rows = await engine.select<{ status: JobStatus }>("SELECT status FROM llm_jobs WHERE id = ?", [id]);
    return rows[0]?.status ?? null;
  },

  /**
   * Conditional write: only queued/running rows move. Returns false when the job
   * was already cancelled (or otherwise terminal), so a late apply cannot resurrect it.
   */
  async updateJob(
    id: string,
    patch: Partial<Pick<LlmJob, "status" | "resultJson" | "error" | "startedAt" | "finishedAt">>,
  ): Promise<boolean> {
    const engine = await getEngine();
    const rows = await engine.select<JobRow>("SELECT * FROM llm_jobs WHERE id = ?", [id]);
    if (!rows[0]) return false;
    if (!patch.status) return false;
    const changed = await engine.execute(
      `UPDATE llm_jobs SET status = ?, result_json = COALESCE(?, result_json), error = COALESCE(?, error),
              started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at)
        WHERE id = ? AND status IN ('queued', 'running')`,
      [
        patch.status,
        patch.resultJson ?? null,
        patch.error ?? null,
        patch.startedAt ?? null,
        patch.finishedAt ?? null,
        id,
      ],
    );
    return changed > 0;
  },

  async listJobs(limit = 40): Promise<LlmJob[]> {
    const engine = await getEngine();
    const rows = await engine.select<JobRow>(
      `SELECT j.*, p.title AS paper_title, p.title_zh AS paper_title_zh,
              p.domain_id AS domain_id, d.name AS domain_name, d.code AS domain_code
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
      paperTitleZh: row.paper_title_zh ?? null,
      domainId: row.domain_id,
      domainName: row.domain_name,
      domainCode: row.domain_code,
    }));
  },

  /** 作业面板用的轻量书目（标题 + 领域）：只查需要的列，不加载作者 / 笔记 / 全文。 */
  async paperBriefs(ids: string[]): Promise<PaperBrief[]> {
    const unique = [...new Set(ids)].filter(Boolean);
    if (!unique.length) return [];
    const engine = await getEngine();
    const rows: Array<{
      id: string;
      title: string;
      title_zh: string | null;
      domain_id: string;
      domain_name: string;
      domain_code: string;
    }> = [];
    // 分块查询：一次导入上千篇时，IN 列表不超出 SQLite 的绑定参数上限。
    for (let start = 0; start < unique.length; start += 400) {
      const chunk = unique.slice(start, start + 400);
      rows.push(
        ...(await engine.select<(typeof rows)[number]>(
          `SELECT p.id, p.title, p.title_zh, p.domain_id, d.name AS domain_name, d.code AS domain_code
             FROM papers p JOIN domains d ON d.id = p.domain_id
            WHERE p.id IN (${chunk.map(() => "?").join(", ")})`,
          chunk,
        )),
      );
    }
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      titleZh: row.title_zh,
      domainId: row.domain_id,
      domainName: row.domain_name,
      domainCode: row.domain_code,
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
      credFingerprint?: string | null;
    },
  ): Promise<boolean> {
    const engine = await getEngine();
    const rows = await engine.select<PaperRow>("SELECT * FROM papers WHERE id = ?", [id]);
    if (!rows[0]) return false;
    const prev = mapPaper(rows[0]);
    const nextStatus = patch.status === undefined ? prev.mineruStatus : patch.status;
    // 取消和认领完成不得盖住已经结束的状态：只有还在排队/已提交/解析中才能写成这两态。
    const inflightGuard =
      nextStatus === "done" || nextStatus === "cancelled"
        ? " AND mineru_status IN ('queued','submitted','parsing')"
        : "";
    const changed = await engine.execute(
      `UPDATE papers SET mineru_status = ?, mineru_parse_id = ?, mineru_doc_ref = ?, mineru_error = ?, mineru_parse_ids = ?, mineru_provider = ?, mineru_cred_fingerprint = ?, updated_at = ? WHERE id = ?${inflightGuard}`,
      [
        nextStatus,
        patch.parseId === undefined ? prev.mineruParseId : patch.parseId,
        patch.docRef === undefined ? prev.mineruDocRef : patch.docRef,
        patch.error === undefined ? prev.mineruError : patch.error,
        JSON.stringify(patch.parseIds === undefined ? prev.mineruParseIds : patch.parseIds),
        patch.provider === undefined ? (rows[0].mineru_provider ?? null) : patch.provider,
        patch.credFingerprint === undefined ? (rows[0].mineru_cred_fingerprint ?? null) : patch.credFingerprint,
        nowIso(),
        id,
      ],
    );
    return changed > 0;
  },

  /** 认领完成写成 done 之后发现论文已取消：只把刚刚写成 done 的作业改回 cancelled。 */
  async revertDoneJob(id: string): Promise<boolean> {
    const engine = await getEngine();
    const changed = await engine.execute(
      `UPDATE llm_jobs SET status = 'cancelled', error = 'cancelled', finished_at = ?
        WHERE id = ? AND status = 'done'`,
      [nowIso(), id],
    );
    return changed > 0;
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
