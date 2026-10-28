import { useEffect, useRef, useState } from "react";
import { onMarkdownClick, renderMarkdown } from "../lib/markdown";
import { openLocalPdf } from "../lib/mineru";
import {
  JOB_STATUS_LABELS,
  JOB_TYPE_LABELS,
  MINERU_PROVIDER_LABELS,
  MINERU_STATUS_LABELS,
  NOTE_DISPLAY_ORDER,
  NOTE_LABELS,
  READING_STATUS_LABELS,
  noteSourceLabel,
  type NoteKind,
  type OpenSource,
  type PaperDetail,
  type ReadingStatus,
} from "../lib/types";
import { hasUsableProvider } from "../lib/settings";
import { arxivAbsUrl, arxivPdfUrl, doiUrl, openExternal, safeHttpUrl } from "../lib/urls";
import { formatDate, pad2 } from "../lib/util";
import { diffStage, type StageField } from "../lib/readingHolds";
import { useField } from "../store";
import { Button, Dialog, Empty, ExternalResource, Icon, SourceBadge } from "./ui";

function NoteEditor({
  kind,
  index,
  paper,
  proseText,
  changed,
  onStart,
}: {
  kind: NoteKind;
  index: number;
  paper: PaperDetail;
  proseText: string;
  changed: boolean;
  onStart: () => void;
}) {
  const saveNote = useField((s) => s.saveNote);
  const setNoteDraft = useField((s) => s.setNoteDraft);
  // 草稿存在 store 里（按论文、按块）：切换论文、搜索、后台刷新都不会丢，切回来编辑框还在。
  const draft = useField((s) => s.drafts[paper.id]?.[kind]);
  const editing = draft !== undefined;
  const block = paper.notes[kind];
  const value = editing ? draft : proseText;
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
    else setFailed(false);
  }, [editing]);

  const label = NOTE_LABELS[kind];

  async function commit() {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await saveNote(paper.id, kind, value);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setFailed(false);
    setNoteDraft(paper.id, kind, null);
  }

  return (
    <section
      className={["ef-note", editing ? "is-editing" : "", value.trim() ? "" : "is-empty"].filter(Boolean).join(" ")}
      id={`note-${kind}`}
      data-saved-change={changed ? "true" : undefined}
    >
      <div className="ef-note-head">
        <span className="ef-note-number" aria-hidden="true">
          {pad2(index + 1)}
        </span>
        <h3>{label.zh}</h3>
        {/* 来源标签只对写了内容的块有意义；空块不标「手动笔记」。 */}
        {value.trim() ? <span className={`ef-note-source is-${block.source}`}>{noteSourceLabel(block)}</span> : null}
        {editing || !value.trim() ? null : (
          <button type="button" className="ef-note-edit" onClick={onStart} aria-label={`编辑${label.zh}`}>
            <Icon name="edit" />
            编辑
          </button>
        )}
      </div>
      {editing ? (
        <>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setNoteDraft(paper.id, kind, e.target.value)}
            aria-label={`${label.zh}内容`}
          />
          <div className="ef-edit-actions">
            <span className="ef-edit-hint">
              {saving ? "保存中…" : failed ? "保存失败，输入已保留，可重试。" : "编辑中 · 尚未保存"}
            </span>
            <Button type="button" size="sm" onClick={cancel} disabled={saving}>
              取消
            </Button>
            <Button type="button" size="sm" variant="primary" onClick={() => void commit()} disabled={saving}>
              {saving ? "保存中…" : "保存笔记"}
            </Button>
          </div>
        </>
      ) : value.trim() ? (
        <div className="ef-note-text ef-md" onClick={onMarkdownClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }} />
      ) : (
        // 空块本身就是入口：点这里就地开写，不必去工具条或右上角找按钮。
        <button type="button" className="ef-note-start" onClick={onStart}>
          <Icon name="plus" />
          写{label.zh}
        </button>
      )}
    </section>
  );
}

function ContextPanel({
  paper,
  activeSection,
  onJump,
}: {
  paper: PaperDetail;
  activeSection: string;
  onJump: (id: string) => void;
}) {
  const settings = useField((s) => s.settings);
  const jobs = useField((s) => s.jobs);
  const setReadingStatus = useField((s) => s.setReadingStatus);
  const runPrepareMeta = useField((s) => s.runPrepareMeta);
  const runRefreshLinks = useField((s) => s.runRefreshLinks);
  const runDraftNotes = useField((s) => s.runDraftNotes);
  const retryMineru = useField((s) => s.retryMineru);
  const stageHold = useField((s) => s.stageHold);
  const mineru = useField((s) => s.mineru);
  const cancelJob = useField((s) => s.cancelJob);
  const savePaperPatch = useField((s) => s.savePaperPatch);
  const setMode = useField((s) => s.setMode);
  const lookupHint = useField((s) => s.lookupHint);
  const openDialog = useField((s) => s.openDialog);
  const active = jobs.filter(
    (job) => job.paperId === paper.id && (job.status === "running" || job.status === "queued"),
  );
  const prose = stageHold?.paperId === paper.id ? stageHold.prose : null;
  const margin = prose ? diffStage(prose, paper) : [];
  const mark = (field: StageField) => (margin.includes(field) ? "true" : undefined);
  const doi = prose ? prose.doi || null : paper.doi;
  const arxivId = prose ? prose.arxivId || null : paper.arxivId;
  const codeUrl = prose ? prose.codeUrl || null : paper.codeUrl;
  const projectPage = prose ? prose.projectPage || null : paper.projectPage;
  const venue = prose ? prose.venue || null : paper.venue;
  const yearLabel = prose ? prose.year : paper.year;

  return (
    <aside className="ef-context" aria-label="论文资料与目录">
      <section className="ef-context-block">
        <h2 className="ef-context-title">阅读状态</h2>
        <label className="ef-status-select">
          <Icon name={paper.readingStatus === "read" ? "check" : "file"} />
          <select
            aria-label="修改阅读状态"
            value={paper.readingStatus}
            onChange={(e) => void setReadingStatus(e.target.value as ReadingStatus, paper.id)}
          >
            {(Object.keys(READING_STATUS_LABELS) as ReadingStatus[]).map((status) => (
              <option key={status} value={status}>
                {READING_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <p className="ef-read-date">
          {paper.readingStatus === "read" && paper.readAt
            ? `标记于 ${formatDate(paper.readAt)}`
            : "阅读状态由你手动标记"}
        </p>
      </section>

      <section className="ef-context-block">
        <h2 className="ef-context-title">资料与链接</h2>
        {codeUrl && safeHttpUrl(codeUrl) ? (
          <ExternalResource href={codeUrl} icon="code">
            代码仓库
            <SourceBadge source={paper.fieldSources?.codeUrl} provider={paper.fieldProviders?.codeUrl} />
          </ExternalResource>
        ) : (
          <p className="ef-missing" data-saved-change={mark("codeUrl")}>未提供代码仓库</p>
        )}
        {projectPage && safeHttpUrl(projectPage) ? (
          <ExternalResource href={projectPage} icon="link">
            项目主页
            <SourceBadge source={paper.fieldSources?.projectPage} provider={paper.fieldProviders?.projectPage} />
          </ExternalResource>
        ) : (
          <p className="ef-missing" data-saved-change={mark("projectPage")}>未提供项目主页</p>
        )}
        <div className="ef-identifier" data-saved-change={mark("arxivId")}>
          arXiv
          <SourceBadge source={paper.fieldSources?.arxivId} provider={paper.fieldProviders?.arxivId} />
          {arxivAbsUrl(arxivId) ? (
            <button type="button" className="mono ef-id-link" onClick={() => void openExternal(arxivAbsUrl(arxivId))}>
              {arxivId}
            </button>
          ) : (
            <span className="mono">{arxivId || "未提供"}</span>
          )}
        </div>
        <div className="ef-identifier" data-saved-change={mark("venue") || mark("year")}>
          <span>
            来源
            <SourceBadge source={paper.fieldSources?.venue} provider={paper.fieldProviders?.venue} />
          </span>
          <span className="mono">{[venue, yearLabel].filter(Boolean).join(" ") || "未提供"}</span>
        </div>
        <label className="ef-os-select">
          <span>开源状态</span>
          <select
            value={paper.codeOpenSource}
            onChange={(e) => void savePaperPatch(paper.id, { codeOpenSource: e.target.value as OpenSource })}
            aria-label="开源状态"
          >
            <option value="unknown">未知</option>
            <option value="open">开源</option>
            <option value="closed">闭源</option>
            <option value="request">需申请</option>
          </select>
        </label>
        <details className="ef-metadata-details">
          <summary>
            <Icon name="right" />
            作者、机构与 DOI
          </summary>
          <div className="ef-author-details" data-saved-change={mark("authors")}>
            {prose ? (
              <p>{prose.authors || "作者信息待补充"}</p>
            ) : paper.authors.length ? (
              paper.authors.map((author) => (
                <p key={author.id}>
                  <strong>
                    {author.name}
                    {author.isCorresponding ? " · 通讯" : ""}
                  </strong>
                  <br />
                  {[author.affiliation, author.lab].filter(Boolean).join(" · ") || "机构待补充"}
                </p>
              ))
            ) : (
              <p>作者信息待补充</p>
            )}
            <SourceBadge source={paper.fieldSources?.authors} provider={paper.fieldProviders?.authors} />
            <p data-saved-change={mark("doi")}>
              DOI
              <SourceBadge source={paper.fieldSources?.doi} provider={paper.fieldProviders?.doi} />
              <br />
              {doiUrl(doi) ? (
                <button type="button" className="mono ef-id-link" onClick={() => void openExternal(doiUrl(doi))}>
                  {doi}
                </button>
              ) : (
                <span className="mono">{doi || "未提供"}</span>
              )}
            </p>
          </div>
        </details>
        {paper.pdfPath ? (
          <p className="ef-missing">
            MinerU · {paper.mineruStatus ? MINERU_STATUS_LABELS[paper.mineruStatus] : "尚未解析"}
          </p>
        ) : null}
        {paper.pdfPath && paper.mineruProvider ? (
          <p className="ef-missing">
            解析源：{MINERU_PROVIDER_LABELS[paper.mineruProvider] ?? paper.mineruProvider}
          </p>
        ) : null}
        {paper.mineruError ? <p className="ef-missing is-error">{paper.mineruError}</p> : null}
        {paper.pdfPath && !mineru.configured ? (
          <Button type="button" variant="link" onClick={() => void setMode("system")}>
            配置 MinerU 解析源
            <Icon name="right" />
          </Button>
        ) : paper.pdfPath &&
          mineru.configured &&
          paper.mineruStatus !== "queued" &&
          paper.mineruStatus !== "submitted" &&
          paper.mineruStatus !== "parsing" &&
          paper.mineruStatus !== "done" ? (
          <Button type="button" onClick={() => void retryMineru(paper.id)}>
            {paper.mineruStatus === "error" || paper.mineruStatus === "cancelled" ? "重新解析" : "发送到 MinerU 解析"}
          </Button>
        ) : null}
      </section>

      <section className="ef-context-block">
        <h2 className="ef-context-title">本页目录</h2>
        <nav className="ef-toc" aria-label="本页目录">
          <a
            href="#abstract"
            className={activeSection === "abstract" ? "is-active" : ""}
            onClick={(e) => {
              e.preventDefault();
              onJump("abstract");
            }}
          >
            <span className="mono">—</span>摘要
          </a>
          <a
            href="#fulltext"
            className={activeSection === "fulltext" ? "is-active" : ""}
            onClick={(e) => {
              e.preventDefault();
              onJump("fulltext");
            }}
          >
            <span className="mono">—</span>解析全文
          </a>
          {NOTE_DISPLAY_ORDER.map((kind, i) => (
            <a
              key={kind}
              href={`#note-${kind}`}
              className={activeSection === `note-${kind}` ? "is-active" : ""}
              onClick={(e) => {
                e.preventDefault();
                onJump(`note-${kind}`);
              }}
            >
              <span className="mono">{pad2(i + 1)}</span>
              {NOTE_LABELS[kind].zh}
            </a>
          ))}
        </nav>
      </section>

      <section className="ef-ai-context ef-dark-surface">
        <h2 className="ef-context-title">
          <Icon name="spark" />
          AI 助手
        </h2>
        {hasUsableProvider(settings) ? (
          <p>用于补全论文信息或起草阅读笔记。AI 不会自动把论文标成已读。</p>
        ) : (
          <p>尚未配置 AI 服务，可到设置页配置。手动阅读与笔记不受影响。</p>
        )}
        <div className="ef-ai-buttons">
          <Button
            type="button"
            disabled={!hasUsableProvider(settings) || Boolean(active.length)}
            onClick={() => {
              // AI 不会静默覆盖：手动改过的论文信息先经确认对话框选择保留或覆盖。
              if (paper.userMetaTouched) {
                openDialog("confirm-meta", paper.id);
                return;
              }
              void runPrepareMeta(paper.id, false);
            }}
          >
            <Icon name="file" />
            补全论文信息
          </Button>
          <Button type="button" disabled={Boolean(active.length)} onClick={() => void runRefreshLinks(paper.id)}>
            <Icon name="link" />
            刷新链接
          </Button>
          {lookupHint?.paperId === paper.id && lookupHint.notices.length ? (
            <div className="ef-lookup-hint">
              {lookupHint.notices.map((notice) => (
                <p key={`${notice.source}-${notice.code}`}>{notice.message}</p>
              ))}
              <button type="button" onClick={() => void setMode("system")}>
                设置 → 文献库
              </button>
            </div>
          ) : null}
          <Button
            type="button"
            disabled={!hasUsableProvider(settings) || Boolean(active.length)}
            onClick={() => void runDraftNotes(paper.id)}
          >
            <Icon name="edit" />
            起草阅读笔记
          </Button>
        </div>
        {active.map((job) => (
          <div key={job.id} className="ef-job-row">
            <span>
              {job.status === "running" ? <i className="ef-pulse" aria-hidden="true" /> : null}
              {JOB_TYPE_LABELS[job.type]} · {JOB_STATUS_LABELS[job.status]}
            </span>
            <Button type="button" size="sm" onClick={() => void cancelJob(job.id)}>
              取消
            </Button>
          </div>
        ))}
        {hasUsableProvider(settings) ? null : (
          <Button type="button" variant="link" onClick={() => void setMode("system")}>
            配置 AI 服务
            <Icon name="right" />
          </Button>
        )}
      </section>
    </aside>
  );
}

export function ReadingStage({
  focus,
  onToggleFocus,
  listOpen,
  onToggleList,
  contextOpen,
  onToggleContext,
}: {
  focus: boolean;
  onToggleFocus: () => void;
  listOpen: boolean;
  onToggleList: () => void;
  contextOpen: boolean;
  onToggleContext: () => void;
}) {
  const paper = useField((s) => s.paper);
  const stageHold = useField((s) => s.stageHold);
  const claimFileTitle = useField((s) => s.claimFileTitle);
  const mode = useField((s) => s.mode);
  const search = useField((s) => s.search);
  const openDialog = useField((s) => s.openDialog);
  const setNoteDraft = useField((s) => s.setNoteDraft);
  const setFlash = useField((s) => s.setFlash);
  const papers = useField((s) => s.papers);
  const archive = useField((s) => s.archive);
  const intake = useField((s) => s.intake);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("abstract");
  const scrollRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMenuOpen(false);
    setActiveSection("abstract");
  }, [paper?.id]);

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !paper) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(".ef-abstract, .ef-fulltext, .ef-note"));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
            break;
          }
        }
      },
      { root, rootMargin: "-2% 0px -70% 0px", threshold: 0 },
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [paper?.id]);

  // 滚动动态：仅当阅读滚动越过 0 时在 .ef-read 上写 data-scrolled（跨界才写，
  // 不做逐帧 DOM 写入），工具条据此提白加深分隔线。passive 监听，无滚动逻辑负担。
  useEffect(() => {
    const root = scrollRef.current;
    const stage = root?.closest(".ef-read");
    if (!root || !stage) return;
    const setScrolled = (scrolled: boolean) => {
      if (scrolled) stage.setAttribute("data-scrolled", "true");
      else stage.removeAttribute("data-scrolled");
    };
    let scrolled = root.scrollTop > 0;
    setScrolled(scrolled);
    const onScroll = () => {
      const next = root.scrollTop > 0;
      if (next === scrolled) return;
      scrolled = next;
      setScrolled(next);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      setScrolled(false);
    };
  }, [paper?.id]);

  function jump(id: string) {
    const root = scrollRef.current;
    const target = root?.querySelector<HTMLElement>(`#${id}`);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    setActiveSection(id);
    if (contextOpen) onToggleContext();
  }

  function startEdit(kind: NoteKind) {
    if (!paper) return;
    const held = useField.getState().stageHold;
    const fromProse = held?.paperId === paper.id ? held.prose.notes[kind] : undefined;
    if (useField.getState().drafts[paper.id]?.[kind] === undefined) {
      setNoteDraft(paper.id, kind, fromProse ?? paper.notes[kind].content);
    }
    requestAnimationFrame(() => jump(`note-${kind}`));
  }

  if (!paper) {
    const searching = mode === "field" && search.trim().length > 0;
    const emptyDomain = mode === "field" && !searching;
    return (
      <section className="ef-read" id="stage" aria-labelledby="read-empty">
        <div className="ef-toolbar">
          <Button
            type="button"
            variant="text"
            className="ef-list-back"
            aria-expanded={listOpen}
            onClick={onToggleList}
          >
            <Icon name="menu" />
            论文列表
          </Button>
        </div>
        <div className="ef-read-scroll">
          <div className="ef-reading-grid">
            <Empty
              title={searching ? "没有符合条件的论文" : emptyDomain ? "此领域还没有论文" : "选择一篇论文"}
              body={
                searching
                  ? "可以调整搜索词，或清空搜索后继续阅读。"
                  : emptyDomain
                    ? "使用论文列表底部的「添加论文」导入第一篇论文。"
                    : "从左侧列表选择一篇论文，阅读摘要、撰写阅读笔记，或直接打开 PDF。"
              }
            />
          </div>
        </div>
      </section>
    );
  }

  const prose = stageHold?.paperId === paper.id ? stageHold.prose : null;
  const margin = prose ? diffStage(prose, paper) : [];
  const title = prose ? prose.titleZh || prose.title : paper.titleZh || paper.title;
  const english = prose ? (prose.titleZh ? prose.title : "") : paper.titleZh ? paper.title : "";
  const fileTitle = paper.fieldSources?.title === "file";
  // 选中的论文只是被搜索或筛选挡在列表外时仍保持打开（不自动跳到别的论文），这里说明一下。
  const visibleList = mode === "archive" ? archive : mode === "intake" ? intake : papers;
  const outOfList = mode !== "system" && !visibleList.some((item) => item.id === paper.id);
  const readingStatusLabel = READING_STATUS_LABELS[paper.readingStatus];
  const notesWritten = NOTE_DISPLAY_ORDER.filter((kind) => paper.notes[kind].content.trim()).length;
  const fulltextStatus = paper.parsedMarkdown.trim()
    ? "MinerU 已解析"
    : paper.mineruStatus
      ? `MinerU · ${MINERU_STATUS_LABELS[paper.mineruStatus]}`
      : "尚未解析";
  const context = (
    <ContextPanel
      paper={paper}
      activeSection={activeSection}
      onJump={jump}
    />
  );

  return (
    <section className="ef-read has-context" id="stage" aria-labelledby="paper-title">
      <div className="ef-toolbar">
        <Button
          type="button"
          variant="text"
          className="ef-list-back"
          aria-expanded={listOpen}
          onClick={onToggleList}
        >
          <Icon name="menu" />
          论文列表
        </Button>
        {/* 两层滑轨：平时显示所在领域；正文滚过 0（.ef-read[data-scrolled]）后
            论文标题从下方滑入，标题离开视口时工具条仍保留「正在读哪篇」。 */}
        <span className="ef-toolbar-label">
          <span className="ef-toolbar-crumb">
            <Icon name="file" />
            论文详情<span className="ef-toolbar-sep">/</span>
            {paper.domain.name}
          </span>
          <span className="ef-toolbar-title" aria-hidden="true">
            {title}
          </span>
        </span>
        <span className="ef-toolbar-spacer" />
        {/* 工具条按职责分两组：视图切换（专注 / 资料）只改布局，用安静的文字按钮；
            分隔线之后是对这篇论文的动作：「打开 PDF」是全屏唯一的 primary，编辑论文信息 /
            移动 / 删除这类低频管理操作收进最右的「⋯」。笔记不在这里：每块笔记就地编辑。
            所有控件同高，基线对齐。 */}
        <Button
          type="button"
          variant="text"
          className="ef-focus-btn"
          aria-pressed={focus}
          title={focus ? "退出专注，恢复论文列表与资料栏" : "隐藏论文列表与资料栏，只留正文"}
          onClick={onToggleFocus}
        >
          <Icon name="focus" />
          {focus ? "退出专注" : "专注阅读"}
        </Button>
        <Button
          type="button"
          variant="text"
          className="ef-context-toggle"
          title="论文资料、链接与本页目录"
          onClick={onToggleContext}
        >
          <Icon name="inbox" />
          资料
        </Button>
        <span className="ef-toolbar-divider" aria-hidden="true" />
        {paper.pdfPath ? (
          <Button
            type="button"
            className="ef-pdf-action"
            variant="primary"
            title="用系统默认阅读器打开本地 PDF"
            onClick={() => {
              void openLocalPdf(paper.pdfPath!).catch((err: unknown) => {
                setFlash({
                  tone: "error",
                  text: err instanceof Error ? err.message : "无法打开 PDF",
                });
              });
            }}
          >
            <Icon name="file" />
            打开 PDF
          </Button>
        ) : safeHttpUrl(arxivPdfUrl(paper.arxivId) ?? paper.pdfUrl) ? (
          <Button
            type="button"
            className="ef-pdf-action"
            variant="primary"
            title="在浏览器中打开在线 PDF"
            onClick={() => void openExternal(arxivPdfUrl(paper.arxivId) ?? paper.pdfUrl)}
          >
            <Icon name="external" />
            打开 PDF
          </Button>
        ) : (
          <Button
            type="button"
            className="ef-pdf-action"
            title="这篇论文还没有 PDF，可在论文信息中选择本地文件或填写公开链接"
            onClick={() => openDialog("edit-paper", paper.id)}
          >
            <Icon name="file" />
            补充 PDF
          </Button>
        )}
        <div className="ef-menu-wrap" ref={menuRef}>
          <Button
            type="button"
            variant="text"
            className="ef-icon-btn ef-more-btn"
            aria-label="更多操作"
            title="更多操作"
            aria-expanded={menuOpen}
            aria-controls="action-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Icon name="more" />
          </Button>
          <div className="ef-action-menu" id="action-menu" hidden={!menuOpen}>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                openDialog("edit-paper", paper.id);
              }}
            >
              <Icon name="edit" />
              <span className="ef-menu-text">
                编辑论文信息
                <small>标题、作者、摘要、PDF 与链接</small>
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                openDialog("move-paper", paper.id);
              }}
            >
              <Icon name="inbox" />
              移动到其他领域
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                setMenuOpen(false);
                openDialog("delete-paper", paper.id);
              }}
            >
              <Icon name="trash" />
              删除论文…
            </button>
          </div>
        </div>
      </div>

      <div className="ef-read-scroll" ref={scrollRef} id="read-scroll">
        <div className="ef-reading-grid">
          <article className="ef-document" id="document" key={paper.id}>
            <div className="ef-paper-category">
              {paper.domain.code ? <span className="ef-code">{paper.domain.code}</span> : null}
              <span>{paper.domain.name}</span>
              <i className="ef-category-rule" aria-hidden="true" />
              <span>{readingStatusLabel}</span>
            </div>
            {outOfList ? (
              <p className="ef-out-of-list" role="note">
                这篇论文不在当前列表中（搜索或筛选条件不匹配），仍可继续阅读与编辑。
              </p>
            ) : null}
            <div className="ef-title-row">
              <h1
                id="paper-title"
                className="ef-read-title"
                tabIndex={-1}
                data-saved-change={margin.includes("title") || margin.includes("titleZh") ? "true" : undefined}
              >
                {title}
              </h1>
              {fileTitle ? <SourceBadge source="file" /> : null}
            </div>
            {fileTitle ? (
              <Button type="button" onClick={() => void claimFileTitle(paper.id)}>
                认领标题
              </Button>
            ) : null}
            {english ? <p className="ef-paper-en">{english}</p> : null}
            <p className="ef-paper-author-line" data-saved-change={margin.includes("authors") ? "true" : undefined}>
              {prose
                ? prose.authors || "作者信息待补充"
                : paper.authors.length
                  ? paper.authors.map((author) => author.name).join(" · ")
                  : "作者信息待补充"}
            </p>
            <section className="ef-abstract" id="abstract" data-saved-change={margin.includes("abstract") ? "true" : undefined}>
              <h2 className="ef-section-label">
                <span>
                  摘要
                  <SourceBadge source={paper.fieldSources?.abstract} provider={paper.fieldProviders?.abstract} />
                </span>
                <i className="ef-section-rule" aria-hidden="true" />
              </h2>
              {(prose ? prose.abstract : paper.abstract) ? (
                <p>{prose ? prose.abstract : paper.abstract}</p>
              ) : (
                <p className="ef-empty-note">
                  尚未填写摘要。摘要属于论文信息，不是笔记：
                  <Button type="button" variant="link" onClick={() => openDialog("edit-paper", paper.id)}>
                    编辑论文信息
                  </Button>
                </p>
              )}
            </section>
            <div className="ef-notes-heading">
              <h2 className="ef-section-label">
                <span>阅读笔记</span>
                <small>
                  已写 {notesWritten} / {NOTE_DISPLAY_ORDER.length}
                </small>
                <i className="ef-section-rule" aria-hidden="true" />
              </h2>
            </div>
            <p className="ef-notes-caption">每块笔记都标注来源：手动笔记或 AI 起草；AI 不会静默覆盖你改过的笔记。</p>
            {NOTE_DISPLAY_ORDER.map((kind, index) => (
              <NoteEditor
                key={kind}
                kind={kind}
                index={index}
                paper={paper}
                proseText={prose ? prose.notes[kind] : paper.notes[kind].content}
                changed={margin.includes(kind)}
                onStart={() => startEdit(kind)}
              />
            ))}
            <details className="ef-fulltext" id="fulltext">
              <summary className="ef-section-label">
                <span>解析全文</span>
                <small>{fulltextStatus}</small>
                <i className="ef-section-rule" aria-hidden="true" />
                <Icon name="right" />
              </summary>
              {paper.parsedMarkdown.trim() ? (
                <div
                  className="ef-note-text ef-md"
                  onClick={onMarkdownClick}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(paper.parsedMarkdown) }}
                />
              ) : (
                <p className="ef-empty-note">尚未解析出全文。导入 PDF 并启用解析源后，这里会显示解析结果。</p>
              )}
            </details>
          </article>
        </div>
      </div>
      {context}
      <Dialog
        open={contextOpen}
        title="论文资料与目录"
        onClose={onToggleContext}
        className="context-drawer"
      >
        <ContextPanel paper={paper} activeSection={activeSection} onJump={jump} />
      </Dialog>
    </section>
  );
}
