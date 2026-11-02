import { ConflictError, getEngine, type BatchStep } from "./engine";
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
import { safeHttpUrl, withDefaultScheme } from "./urls";
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
  mineru_job_id?: string | null;
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
  rev?: number | null;
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
    mineruJobId: row.mineru_job_id ?? null,
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
    value === "pending" ||
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

/** 元数据字段 → 列名与编码；SET 子句只由这张白名单拼出。 */
const PAPER_COLUMNS: Record<string, { column: string; encode?: (value: unknown) => unknown }> = {
  title: { column: "title" },
  titleZh: { column: "title_zh" },
  abstract: { column: "abstract" },
  year: { column: "year" },
  venue: { column: "venue" },
  doi: { column: "doi" },
  arxivId: { column: "arxiv_id" },
  pdfUrl: { column: "pdf_url" },
  codeUrl: { column: "code_url" },
  codeOpenSource: { column: "code_open_source" },
  projectPage: { column: "project_page" },
  tags: { column: "tags", encode: (value) => JSON.stringify(value ?? []) },
  labs: { column: "labs", encode: (value) => JSON.stringify(value ?? []) },
  domainId: { column: "domain_id" },
};

function setColumn(sets: string[], params: unknown[], key: string, value: unknown): void {
  const spec = PAPER_COLUMNS[key];
  if (!spec) return;
  sets.push(`${spec.column} = ?`);
  params.push(spec.encode ? spec.encode(value) : value);
}

/**
 * 逐键更新 JSON 对象列（field_sources / field_providers）：只动这次改的键，
 * 不用快照整体覆盖，并发写入的其他键不会丢。
 */
function jsonPatch(column: string, set: Array<[string, string]>, remove: string[]): { sql: string; params: unknown[] } | null {
  if (!set.length && !remove.length) return null;
  let expr = `COALESCE(${column}, '{}')`;
  const params: unknown[] = [];
  if (set.length) {
    expr = `json_set(${expr}, ${set.map(() => "?, ?").join(", ")})`;
    for (const [key, value] of set) params.push(`$.${key}`, value);
  }
  if (remove.length) {
    expr = `json_remove(${expr}, ${remove.map(() => "?").join(", ")})`;
    params.push(...remove.map((key) => `$.${key}`));
  }
  return { sql: `${column} = ${expr}`, params };
}

function authorPayload(
  authors: Array<{ name: string; affiliation?: string | null; lab?: string | null; isCorresponding?: boolean }>,
): string {
  return JSON.stringify(
    authors
      .filter((author) => author.name?.trim())
      .map((author) => ({
        name: author.name.trim(),
        affiliation: author.affiliation?.trim() || "",
        lab: author.lab?.trim() || "",
        corresponding: author.isCorresponding ? 1 : 0,
      })),
  );
}

function claimedRevBlocksInsert(revs: Partial<Record<NoteKind, number>> | undefined, kind: NoteKind): boolean {
  return revs !== undefined && Object.prototype.hasOwnProperty.call(revs, kind);
}

function emptyNoteSteps(paperId: string, at: string): BatchStep[] {
  return NOTE_KINDS.map((kind) => ({
    sql: `INSERT OR IGNORE INTO notes (id, paper_id, kind, content, source, user_edited, revised_at)
       VALUES (?, ?, ?, '', 'manual', 0, ?)`,
    params: [uid(), paperId, kind, at],
  }));
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
            rev: Number(row.rev ?? 0),
            revisedAt: row.revised_at,
          }
        : {
            id: uid(),
            paperId: id,
            kind,
            content: "",
            source: "manual",
            userEdited: false,
            rev: 0,
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

  /**
   * 手动添加时选的本地 PDF 同样复制进文库（库里存相对名，原路径记在 pdf_original_path），
   * 这样它也进备份、也参与去重。已在库中时报错，不重复建档。
   */
  async adoptManualPdf(path: string): Promise<{ libraryPath: string; originalPath: string }> {
    const known = new Set(await this.pdfPaths());
    if (known.has(path)) throw new Error("这个 PDF 已在库中");
    const adopted = await adoptPdf(path);
    if (known.has(adopted.originalPath)) throw new Error("这个 PDF 已在库中");
    return adopted;
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
    // 文件名标题取用户原来的文件名（文库副本带时间戳前缀），来源记 file：文献库与模型都可以替换它。
    const fileTitle = pdfPath ? titleFromPdf(input.pdfOriginalPath?.trim() || pdfPath) : "";
    const title = explicitTitle || fileTitle || "未命名论文";
    const arxivId = input.arxivId?.trim() || null;
    const doi = input.doi?.trim() || null;
    const sources: FieldSources = {};
    if (explicitTitle || input.userOwned) sources.title = "user";
    else if (fileTitle) sources.title = "file";
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
      // 有 PDF 即待解析：没有可用解析源时也能在批量入口里看到它。
      mineruStatus: pdfPath ? "pending" : null,
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
    // 论文与五块空笔记一起提交：不会留下没有笔记行的论文。
    await engine.batch([
      {
        sql: `INSERT INTO papers (
        id, domain_id, title, title_zh, abstract, year, venue, doi, arxiv_id, pdf_url, pdf_path,
        code_url, code_open_source, project_page, reading_status, read_at, llm_prepared_at,
        notes_drafted_by_llm, user_notes_touched, user_meta_touched, mineru_parse_ids, tags, labs,
        field_sources, meta_rev, pdf_original_path, mineru_status, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, '', NULL, NULL, ?, ?, NULL, ?, NULL, 'unknown', NULL, 'unread', NULL, NULL, 0, 0, ?, '[]', '[]', '[]', ?, ?, ?, ?, ?, ?)`,
        params: [
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
          paper.mineruStatus,
          at,
          at,
        ],
        expect: "one",
      },
      ...emptyNoteSteps(paper.id, at),
    ]);
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
    // 只写 patch 里出现的列：后台写入（链接校验、解析状态）不会被这里的旧快照抹掉。
    const engine = await getEngine();
    const sets: string[] = [];
    const params: unknown[] = [];
    const metaKeys: string[] = [];
    for (const [key, raw] of Object.entries(patch)) {
      if (raw === undefined || !PAPER_COLUMNS[key]) continue;
      let value: unknown = raw;
      if (key === "pdfUrl" || key === "codeUrl" || key === "projectPage") {
        // 用户手填的 github.com/x 补上 https://；后台写入只接受完整的 http(s) 链接。
        const text = typeof raw === "string" ? raw : "";
        value = safeHttpUrl(touchMeta ? withDefaultScheme(text) : text);
      }
      setColumn(sets, params, key, value);
      if ((META_PATCH_KEYS as readonly string[]).includes(key)) metaKeys.push(key);
    }
    if (touchMeta && metaKeys.length) {
      const sources = jsonPatch("field_sources", metaKeys.map((key) => [key, "user"]), [])!;
      const providers = jsonPatch("field_providers", [], metaKeys)!;
      sets.push(sources.sql, providers.sql, "user_meta_touched = 1", "meta_rev = meta_rev + 1");
      params.push(...sources.params, ...providers.params);
    }
    sets.push("updated_at = ?");
    params.push(nowIso(), id);
    try {
      await engine.batch([{ sql: `UPDATE papers SET ${sets.join(", ")} WHERE id = ?`, params, expect: "one" }]);
    } catch (err) {
      if (err instanceof ConflictError) throw new Error("论文不存在");
      throw err;
    }
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
    // 各块在同一个事务里：中途失败时一篇都不删，「数据未改动」的提示才成立。
    if (!ids.length) return;
    const engine = await getEngine();
    const steps: BatchStep[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(", ");
      steps.push({ sql: `DELETE FROM papers WHERE id IN (${placeholders})`, params: chunk });
    }
    await engine.batch(steps);
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
    // pf_author_replace runs inside this UPDATE, so the link delete and the
    // author inserts commit or roll back with it.
    await engine.execute(
      `UPDATE papers SET author_replace = ?, updated_at = ?,
         user_meta_touched = CASE WHEN ? = 1 THEN 1 ELSE user_meta_touched END,
         meta_rev = meta_rev + CASE WHEN ? = 1 THEN 1 ELSE 0 END,
         field_sources = CASE WHEN ? = 1
           THEN json_set(COALESCE(field_sources, '{}'), '$.authors', 'user')
           ELSE field_sources END,
         field_providers = CASE WHEN ? = 1
           THEN json_remove(COALESCE(field_providers, '{}'), '$.authors')
           ELSE field_providers END
       WHERE id = ? AND (? IS NULL OR meta_rev = ?)`,
      [
        authorPayload(authors),
        nowIso(),
        touchMeta ? 1 : 0,
        touchMeta ? 1 : 0,
        touchMeta ? 1 : 0,
        touchMeta ? 1 : 0,
        paperId,
        expectedMetaRev,
        expectedMetaRev,
      ],
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
    const steps: BatchStep[] = [];
    if (existing[0]) {
      steps.push({
        sql: `UPDATE notes SET content = ?, source = CASE WHEN ? = 'llm' AND user_edited = 0 THEN 'llm' ELSE source END,
           user_edited = ?, rev = rev + 1, revised_at = ? WHERE id = ?`,
        params: [content, source, markUserEdited ? 1 : existing[0].user_edited, at, existing[0].id],
        expect: "one",
      });
    } else {
      steps.push({
        sql: `INSERT INTO notes (id, paper_id, kind, content, source, user_edited, rev, revised_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        params: [uid(), paperId, kind, content, source, markUserEdited ? 1 : 0, at],
      });
    }
    steps.push(
      markUserEdited
        ? { sql: "UPDATE papers SET user_notes_touched = 1, updated_at = ? WHERE id = ?", params: [at, paperId] }
        : { sql: "UPDATE papers SET updated_at = ? WHERE id = ?", params: [at, paperId] },
    );
    await engine.batch(steps);
  },

  async applyPreparedMeta(
    paperId: string,
    meta: PreparedMeta,
    overwrite = false,
    ctx?: {
      startedRev?: number;
      source?: FieldSource;
      jobId?: string;
      replaceApi?: boolean;
      /** 与这次写入同一个事务提交的一步（通常是作业 → done）；它的前提不成立时整批不写。 */
      finish?: BatchStep;
    },
  ): Promise<"committed" | "cancelled" | "conflict"> {
    const engine = await getEngine();
    const source: "api" | "llm" = ctx?.source === "api" ? "api" : "llm";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (ctx?.jobId && (await this.jobStatus(ctx.jobId)) !== "running") return "cancelled";
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
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const field of plan.changed) {
        if (field !== "authors") setColumn(sets, params, field, plan[field]);
      }
      const sources = jsonPatch(
        "field_sources",
        plan.changed.map((field) => [field, plan.fieldSources[field]!]),
        [],
      );
      const providers = jsonPatch(
        "field_providers",
        plan.changed.filter((field) => plan.fieldProviders[field]).map((field) => [field, plan.fieldProviders[field]!]),
        plan.changed.filter((field) => !plan.fieldProviders[field]),
      );
      for (const patch of [sources, providers]) {
        if (!patch) continue;
        sets.push(patch.sql);
        params.push(...patch.params);
      }
      sets.push(
        "meta_confidence = COALESCE(?, meta_confidence)",
        "llm_prepared_at = CASE WHEN ? = 'llm' THEN ? ELSE llm_prepared_at END",
        "updated_at = ?",
      );
      params.push(plan.confidence, source, at, at);
      const jobId = ctx?.jobId ?? "";
      // 字段、来源与作者在同一个事务里：meta_rev 变了（用户刚改过）或作业已取消，整批不写，重读再来。
      const steps: BatchStep[] = [
        {
          sql: `UPDATE papers SET ${sets.join(", ")}
                 WHERE id = ? AND meta_rev = ?
                   AND (? = '' OR EXISTS (SELECT 1 FROM llm_jobs WHERE id = ? AND status = 'running'))`,
          params: [...params, paperId, prev.metaRev ?? 0, jobId, jobId],
          expect: "one",
        },
      ];
      if (plan.replaceAuthors) {
        steps.push({
          sql: "UPDATE papers SET author_replace = ? WHERE id = ? AND meta_rev = ?",
          params: [authorPayload(meta.authors), paperId, prev.metaRev ?? 0],
          expect: "one",
        });
      }
      if (ctx?.finish) steps.push(ctx.finish);
      try {
        await engine.batch(steps);
        return "committed";
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        if (ctx?.finish && err.step === steps.length - 1) return "cancelled";
      }
    }
    return "conflict";
  },

  /**
   * AI 起草的笔记逐块写入。`revs` 是作业开始（或用户确认覆盖）时每块的版本号：
   * 请求期间被用户改过的块版本号已变，整块跳过。不覆盖时用户改过的块一律保留。
   * 返回被保留下来的块。
   */
  async applyDraftedNotes(
    paperId: string,
    notes: DraftedNotes,
    overwrite: boolean,
    revs?: Partial<Record<NoteKind, number>>,
    /** 与笔记同一个事务提交的一步（作业 → done）；作业已被取消时整批不写，返回 null。 */
    finish?: BatchStep,
  ): Promise<NoteKind[] | null> {
    const engine = await getEngine();
    const paper = await engine.select<PaperRow>("SELECT * FROM papers WHERE id = ?", [paperId]);
    if (!paper[0]) throw new Error("论文不存在");
    const blocks = await engine.select<NoteRow>("SELECT * FROM notes WHERE paper_id = ?", [paperId]);
    const at = nowIso();
    const steps: BatchStep[] = [];
    const candidates: NoteKind[] = [];
    for (const kind of NOTE_KINDS) {
      const block = blocks.find((row) => row.kind === kind);
      if (block) {
        if (block.user_edited && !overwrite) continue;
        candidates.push(kind);
        steps.push({
          sql: `UPDATE notes SET content = ?, source = 'llm', user_edited = 0, rev = rev + 1, revised_at = ?
                 WHERE id = ? AND rev = ? AND (user_edited = 0 OR ? = 1)`,
          params: [notes[kind] ?? "", at, block.id, revs?.[kind] ?? Number(block.rev ?? 0), overwrite ? 1 : 0],
        });
      } else if (!claimedRevBlocksInsert(revs, kind)) {
        candidates.push(kind);
        steps.push({
          sql: `INSERT OR IGNORE INTO notes (id, paper_id, kind, content, source, user_edited, rev, revised_at)
                VALUES (?, ?, ?, ?, 'llm', 0, 1, ?)`,
          params: [uid(), paperId, kind, notes[kind] ?? "", at],
        });
      }
    }
    steps.push({ sql: "UPDATE papers SET notes_drafted_by_llm = 1, updated_at = ? WHERE id = ?", params: [at, paperId] });
    if (finish) steps.push(finish);
    let rows: number[];
    try {
      rows = await engine.batch(steps);
    } catch (err) {
      if (finish && err instanceof ConflictError) return null;
      throw err;
    }
    const written = new Set(candidates.filter((_, index) => rows[index] > 0));
    return NOTE_KINDS.filter((kind) => !written.has(kind));
  },

  /**
   * 后台链接校验的条件写入：只有链接仍是检查时那个值、且不归用户时才改。
   * 校验期间用户在编辑框里改过的链接不会被清掉或换回去。返回是否写入。
   */
  async replaceLinkIf(
    paperId: string,
    field: "codeUrl" | "projectPage",
    expected: string | null,
    next: string | null,
  ): Promise<boolean> {
    const engine = await getEngine();
    const column = field === "codeUrl" ? "code_url" : "project_page";
    const changed = await engine.execute(
      `UPDATE papers SET ${column} = ?,
         field_sources = CASE WHEN ? IS NULL THEN json_remove(COALESCE(field_sources, '{}'), ?) ELSE field_sources END,
         field_providers = CASE WHEN ? IS NULL THEN json_remove(COALESCE(field_providers, '{}'), ?) ELSE field_providers END,
         updated_at = ?
       WHERE id = ? AND ${column} IS ? AND IFNULL(json_extract(field_sources, ?), '') <> 'user'`,
      [next, next, `$.${field}`, next, `$.${field}`, nowIso(), paperId, expected, `$.${field}`],
    );
    return changed > 0;
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

  /**
   * 建作业即进入 running。`claimMineru` 时同一事务里把论文的解析状态所有权交给这次作业：
   * 之后只有它能改写解析状态，重新解析或取消收回所有权后，旧的一轮写什么都不生效。
   */
  async startJob(
    paperId: string,
    type: JobType,
    prompt: string | null,
    claimMineru?: { resume: boolean },
  ): Promise<LlmJob> {
    const engine = await getEngine();
    const at = nowIso();
    const job: LlmJob = {
      id: uid(),
      paperId,
      type,
      status: "running",
      prompt,
      resultJson: null,
      error: null,
      createdAt: at,
      startedAt: at,
      finishedAt: null,
    };
    const steps: BatchStep[] = [
      {
        sql: `INSERT INTO llm_jobs (id, paper_id, type, status, prompt, result_json, error, created_at, started_at, finished_at)
              VALUES (?, ?, ?, 'running', ?, NULL, NULL, ?, ?, NULL)`,
        params: [job.id, paperId, type, prompt, at, at],
        expect: "one",
      },
    ];
    if (claimMineru) {
      steps.push({
        sql: `UPDATE papers SET mineru_job_id = ?,
                mineru_status = CASE WHEN ? = 1 THEN mineru_status ELSE 'queued' END,
                mineru_error = CASE WHEN ? = 1 THEN mineru_error ELSE NULL END,
                updated_at = ?
              WHERE id = ?`,
        params: [job.id, claimMineru.resume ? 1 : 0, claimMineru.resume ? 1 : 0, at, paperId],
        expect: "one",
      });
    }
    await engine.batch(steps);
    return job;
  },

  /**
   * 结束一个作业，并把随之落库的数据放进同一个事务：作业行只在仍是 running 时才改，
   * 任何一步前提不成立（作业已被取消、解析所有权已被收回……）整批回滚。返回是否提交。
   */
  async finishJob(
    jobId: string,
    status: "done" | "error" | "cancelled",
    options: { error?: string | null; resultJson?: string | null; steps?: BatchStep[] } = {},
  ): Promise<boolean> {
    const engine = await getEngine();
    try {
      await engine.batch([
        {
          sql: `UPDATE llm_jobs SET status = ?, error = COALESCE(?, error), result_json = COALESCE(?, result_json), finished_at = ?
                 WHERE id = ? AND status IN ('queued', 'running')`,
          params: [status, options.error ?? null, options.resultJson ?? null, nowIso(), jobId],
          expect: "one",
        },
        ...(options.steps ?? []),
      ]);
      return true;
    } catch (err) {
      if (err instanceof ConflictError) return false;
      throw err;
    }
  },

  /** 这篇论文的解析状态是否仍归这次作业所有，且作业仍在运行。 */
  async ownsMineru(paperId: string, jobId: string): Promise<boolean> {
    const engine = await getEngine();
    const rows = await engine.select<{ ok: number }>(
      `SELECT 1 AS ok FROM papers p JOIN llm_jobs j ON j.id = ?
        WHERE p.id = ? AND p.mineru_job_id = ? AND j.status = 'running'`,
      [jobId, paperId, jobId],
    );
    return rows.length > 0;
  },

  /** 某篇论文仍在排队或运行的作业（删除论文前取消它们）。 */
  async activeJobIds(paperIds: string[]): Promise<Array<{ id: string; paperId: string; type: JobType }>> {
    if (!paperIds.length) return [];
    const engine = await getEngine();
    const out: Array<{ id: string; paperId: string; type: JobType }> = [];
    for (let i = 0; i < paperIds.length; i += 400) {
      const chunk = paperIds.slice(i, i + 400);
      const rows = await engine.select<{ id: string; paper_id: string; type: JobType }>(
        `SELECT id, paper_id, type FROM llm_jobs
          WHERE status IN ('queued', 'running') AND paper_id IN (${chunk.map(() => "?").join(", ")})`,
        chunk,
      );
      out.push(...rows.map((row) => ({ id: row.id, paperId: row.paper_id, type: row.type })));
    }
    return out;
  },

  async paperIdsInDomain(domainId: string): Promise<string[]> {
    const engine = await getEngine();
    const rows = await engine.select<{ id: string }>("SELECT id FROM papers WHERE domain_id = ?", [domainId]);
    return rows.map((row) => row.id);
  },

  /** 重新解析：重置解析状态并收回所有权，旧的一轮写入不再生效。多篇在同一个事务里。 */
  async resetMineru(paperIds: string[]): Promise<void> {
    if (!paperIds.length) return;
    const engine = await getEngine();
    const at = nowIso();
    await engine.batch(
      paperIds.map((id) => ({
        sql: `UPDATE papers SET mineru_status = 'queued', mineru_error = NULL, mineru_parse_id = NULL,
                mineru_parse_ids = '[]', mineru_doc_ref = NULL, mineru_provider = NULL,
                mineru_cred_fingerprint = NULL, mineru_job_id = NULL, updated_at = ?
              WHERE id = ?`,
        params: [at, id],
      })),
    );
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
      /** 改写解析状态的所有者；null 表示收回所有权（重新解析时让旧的一轮失效）。 */
      jobId?: string | null;
    },
    /** 只有当前所有者（那次 MinerU 作业）才能写；缺省表示不绑定在某次运行上。 */
    owner?: string,
  ): Promise<boolean> {
    const engine = await getEngine();
    const rows = await engine.select<PaperRow>("SELECT * FROM papers WHERE id = ?", [id]);
    if (!rows[0]) return false;
    const prev = mapPaper(rows[0]);
    const nextStatus = patch.status === undefined ? prev.mineruStatus : patch.status;
    // 取消和认领完成不得盖住已经结束的状态：只有还在等待/排队/已提交/解析中才能写成这两态。
    const inflightGuard =
      nextStatus === "done" || nextStatus === "cancelled"
        ? " AND mineru_status IN ('pending','queued','submitted','parsing')"
        : "";
    const ownerGuard = owner === undefined ? "" : " AND mineru_job_id IS ?";
    const changed = await engine.execute(
      `UPDATE papers SET mineru_status = ?, mineru_parse_id = ?, mineru_doc_ref = ?, mineru_error = ?, mineru_parse_ids = ?, mineru_provider = ?, mineru_cred_fingerprint = ?, mineru_job_id = ?, updated_at = ? WHERE id = ?${inflightGuard}${ownerGuard}`,
      [
        nextStatus,
        patch.parseId === undefined ? prev.mineruParseId : patch.parseId,
        patch.docRef === undefined ? prev.mineruDocRef : patch.docRef,
        patch.error === undefined ? prev.mineruError : patch.error,
        JSON.stringify(patch.parseIds === undefined ? prev.mineruParseIds : patch.parseIds),
        patch.provider === undefined ? (rows[0].mineru_provider ?? null) : patch.provider,
        patch.credFingerprint === undefined ? (rows[0].mineru_cred_fingerprint ?? null) : patch.credFingerprint,
        patch.jobId === undefined ? (rows[0].mineru_job_id ?? null) : patch.jobId,
        nowIso(),
        id,
        ...(owner === undefined ? [] : [owner]),
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
    await engine.batch([
      {
        sql: `INSERT INTO paper_parse (paper_id, markdown, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(paper_id) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at`,
        params: [id, markdown, at],
      },
      { sql: "UPDATE papers SET updated_at = ? WHERE id = ?", params: [at, id] },
    ]);
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

  /** 解析失败或从未提交过解析的论文（供 INTAKE 页批量发送）；跨领域，按时间先后排序。 */
  async listFailedMineru(): Promise<string[]> {
    const engine = await getEngine();
    const rows = await engine.select<{ id: string }>(
      `SELECT id FROM papers
        WHERE pdf_path IS NOT NULL AND pdf_path != '' AND mineru_status IN ('error', 'pending')
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
