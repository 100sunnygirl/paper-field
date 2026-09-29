import { useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../lib/markdown";
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
import { formatDate, pad2 } from "../lib/util";
import { useField } from "../store";
import { Button, ButtonLink, Dialog, Empty, ExternalResource, Icon } from "./ui";

function NoteEditor({
  kind,
  index,
  paper,
  editing,
  onStart,
  onStop,
}: {
  kind: NoteKind;
  index: number;
  paper: PaperDetail;
  editing: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const saveNote = useField((s) => s.saveNote);
  const setUnsavedNote = useField((s) => s.setUnsavedNote);
  const block = paper.notes[kind];
  const [value, setValue] = useState(block.content);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) {
      setValue(block.content);
      setFailed(false);
    }
  }, [block.content, paper.id, kind, editing]);

  useEffect(() => {
    if (editing) {
      setUnsavedNote(true);
      textareaRef.current?.focus();
    }
  }, [editing, setUnsavedNote]);

  const label = NOTE_LABELS[kind];

  async function commit() {
    setSaving(true);
    setFailed(false);
    try {
      await saveNote(kind, value);
      setUnsavedNote(false);
      onStop();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setValue(block.content);
    setFailed(false);
    setUnsavedNote(false);
    onStop();
  }

  return (
    <section className="ef-note" id={`note-${kind}`}>
      <div className="ef-note-head">
        <h3>
          <span className="ef-note-number">{pad2(index + 1)}</span>
          {label.zh}
        </h3>
        <span className="ef-note-source">{noteSourceLabel(block)}</span>
        {editing ? null : (
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
            onChange={(e) => setValue(e.target.value)}
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
        <div className="ef-note-text ef-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }} />
      ) : (
        <p className="ef-empty-note">尚未记录，点击「编辑」写下你的判断。</p>
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
  const runDraftNotes = useField((s) => s.runDraftNotes);
  const retryMineru = useField((s) => s.retryMineru);
  const mineru = useField((s) => s.mineru);
  const cancelJob = useField((s) => s.cancelJob);
  const savePaperPatch = useField((s) => s.savePaperPatch);
  const setMode = useField((s) => s.setMode);
  const openDialog = useField((s) => s.openDialog);
  const active = jobs.filter(
    (job) => job.paperId === paper.id && (job.status === "running" || job.status === "queued"),
  );

  return (
    <aside className="ef-context" aria-label="论文资料与目录">
      <section className="ef-context-block">
        <h2 className="ef-context-title">阅读状态</h2>
        <label className="ef-status-select">
          <Icon name={paper.readingStatus === "read" ? "check" : "file"} />
          <select
            aria-label="修改阅读状态"
            value={paper.readingStatus}
            onChange={(e) => void setReadingStatus(e.target.value as ReadingStatus)}
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
        {paper.codeUrl ? (
          <ExternalResource href={paper.codeUrl} icon="code">
            代码仓库
          </ExternalResource>
        ) : (
          <p className="ef-missing">未提供代码仓库</p>
        )}
        {paper.projectPage ? (
          <ExternalResource href={paper.projectPage} icon="link">
            项目主页
          </ExternalResource>
        ) : (
          <p className="ef-missing">未提供项目主页</p>
        )}
        <div className="ef-identifier">
          arXiv
          <span className="mono">{paper.arxivId || "未提供"}</span>
        </div>
        <label className="ef-os-select">
          <span>开源状态</span>
          <select
            value={paper.codeOpenSource}
            onChange={(e) => void savePaperPatch({ codeOpenSource: e.target.value as OpenSource })}
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
          <div className="ef-author-details">
            {paper.authors.length ? (
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
            <p>
              DOI
              <br />
              <span className="mono">{paper.doi || "未提供"}</span>
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
            解析来源：{MINERU_PROVIDER_LABELS[paper.mineruProvider] ?? paper.mineruProvider}
          </p>
        ) : null}
        {paper.mineruError ? <p style={{ color: "var(--pf-danger)" }}>{paper.mineruError}</p> : null}
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

      <section className="ef-ai-context">
        <h2 className="ef-context-title">
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <Icon name="spark" /> AI 助手
          </span>
        </h2>
        {settings.hasKey ? (
          <p>用于补全元数据或起草笔记草稿。不会自动把论文标成已读。</p>
        ) : (
          <p>尚未配置服务。阅读与手动笔记不受影响。</p>
        )}
        <div className="ef-ai-buttons">
          <Button
            type="button"
            disabled={!settings.hasKey || Boolean(active.length)}
            onClick={() => {
              // AI 不会静默覆盖：手动改过的论文信息先经确认对话框选择保留或覆盖。
              if (paper.userMetaTouched) {
                openDialog("confirm-meta");
                return;
              }
              void runPrepareMeta(paper.id);
            }}
          >
            <Icon name="file" />
            补全论文信息
          </Button>
          <Button
            type="button"
            disabled={!settings.hasKey || Boolean(active.length)}
            onClick={() => void runDraftNotes(paper.id)}
          >
            <Icon name="edit" />
            起草阅读笔记
          </Button>
        </div>
        {active.map((job) => (
          <div key={job.id} className="ef-job-row" style={{ marginTop: 8 }}>
            <span>
              {job.status === "running" ? <i className="ef-pulse" aria-hidden="true" /> : null}
              {JOB_TYPE_LABELS[job.type]} · {JOB_STATUS_LABELS[job.status]}
            </span>
            <Button type="button" size="sm" onClick={() => void cancelJob(job.id)}>
              取消
            </Button>
          </div>
        ))}
        {settings.hasKey ? null : (
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
  const mode = useField((s) => s.mode);
  const openDialog = useField((s) => s.openDialog);
  const unsavedNote = useField((s) => s.unsavedNote);
  const setFlash = useField((s) => s.setFlash);
  const [editingKind, setEditingKind] = useState<NoteKind | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("abstract");
  const scrollRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEditingKind(null);
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

  const venueLine = useMemo(() => {
    if (!paper) return "";
    return [paper.venue, paper.year].filter(Boolean).join(" ");
  }, [paper]);

  function jump(id: string) {
    const root = scrollRef.current;
    const target = root?.querySelector<HTMLElement>(`#${id}`);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    setActiveSection(id);
    if (contextOpen) onToggleContext();
  }

  function startEdit(kind: NoteKind) {
    if (unsavedNote && editingKind && editingKind !== kind) {
      setFlash({ tone: "warn", text: "请先保存或取消正在编辑的笔记。" });
      return;
    }
    setEditingKind(kind);
    requestAnimationFrame(() => jump(`note-${kind}`));
  }

  function writeNote() {
    if (!paper) return;
    const empty = NOTE_DISPLAY_ORDER.find((kind) => !paper.notes[kind].content.trim());
    startEdit(empty ?? "remarks");
  }

  if (!paper) {
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
              title="选择一篇论文"
              body="从左侧列表选择论文，阅读摘要并撰写现场笔记。打开 PDF 是本页的主操作。"
              action={
                mode === "field" ? (
                  <Button type="button" variant="primary" onClick={() => openDialog("paper")}>
                    <Icon name="plus" />
                    导入 PDF
                  </Button>
                ) : null
              }
            />
          </div>
        </div>
      </section>
    );
  }

  const title = paper.titleZh || paper.title;
  const english = paper.titleZh ? paper.title : "";
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
        <span className="ef-toolbar-label">
          <Icon name="file" />
          论文详情
        </span>
        <span className="ef-toolbar-spacer" />
        <Button
          type="button"
          variant="text"
          className="ef-focus-btn"
          aria-pressed={focus}
          onClick={onToggleFocus}
        >
          <Icon name="focus" />
          {focus ? "退出专注" : "专注阅读"}
        </Button>
        <Button type="button" variant="text" className="ef-context-toggle" onClick={onToggleContext}>
          <Icon name="inbox" />
          资料
        </Button>
        {paper.pdfPath ? (
          <Button
            type="button"
            className="ef-pdf-action"
            variant="primary"
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
        ) : paper.pdfUrl ? (
          <ButtonLink
            className="ef-pdf-action"
            variant="primary"
            href={paper.pdfUrl}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="file" />
            打开 PDF
            <Icon name="external" className="ef-ico" />
          </ButtonLink>
        ) : (
          <Button
            type="button"
            className="ef-pdf-action"
            variant="primary"
            onClick={() => setFlash({ tone: "warn", text: "这篇论文还没有本地 PDF。" })}
          >
            <Icon name="file" />
            打开 PDF
          </Button>
        )}
        <Button type="button" className="ef-write-note" onClick={writeNote}>
          <Icon name="edit" />
          写笔记
        </Button>
        <div className="ef-menu-wrap" ref={menuRef}>
          <Button
            type="button"
            variant="text"
            className="more-btn"
            aria-expanded={menuOpen}
            aria-controls="action-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="more-word">更多</span>
            <Icon name="down" />
          </Button>
          <div className="ef-action-menu" id="action-menu" hidden={!menuOpen}>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                openDialog("edit-paper");
              }}
            >
              <Icon name="edit" />
              编辑论文信息
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                openDialog("move-paper");
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
                openDialog("delete-paper");
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
          <article className="ef-document" id="document">
            <div className="ef-paper-category">
              <span>研究论文</span>
              <i className="ef-category-rule" aria-hidden="true" />
              <span>{venueLine || paper.domain.name}</span>
            </div>
            <h1 id="paper-title" className="ef-read-title" tabIndex={-1}>
              {title}
            </h1>
            {english ? <p className="ef-paper-en">{english}</p> : null}
            <p className="ef-paper-author-line">
              {paper.authors.length
                ? paper.authors.map((author) => author.name).join(" · ")
                : "作者信息待补充"}
            </p>
            <section className="ef-abstract" id="abstract">
              <h2 className="ef-section-label">
                摘要 <small>ABSTRACT</small>
              </h2>
              <p>{paper.abstract || "尚未填写摘要。可在「更多」中编辑论文信息。"}</p>
            </section>
            <details className="ef-metadata-details ef-fulltext" id="fulltext">
              <summary>
                <Icon name="right" />
                解析全文（MinerU）
              </summary>
              {paper.parsedMarkdown.trim() ? (
                <div
                  className="ef-note-text ef-md"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(paper.parsedMarkdown) }}
                />
              ) : (
                <p className="ef-empty-note">尚未解析出全文。</p>
              )}
            </details>
            <div className="ef-notes-heading">
              <h2>现场笔记</h2>
              <span className="ef-overline">FIELD NOTES</span>
            </div>
            <p className="ef-notes-caption">保留自己的判断，也区分 AI 起草与人工修订。</p>
            {NOTE_DISPLAY_ORDER.map((kind, index) => (
              <NoteEditor
                key={kind}
                kind={kind}
                index={index}
                paper={paper}
                editing={editingKind === kind}
                onStart={() => startEdit(kind)}
                onStop={() => setEditingKind(null)}
              />
            ))}
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
