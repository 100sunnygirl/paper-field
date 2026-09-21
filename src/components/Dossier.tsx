import { useEffect, useState } from "react";
import { renderMarkdown } from "../lib/markdown";
import { NOTE_KINDS, NOTE_LABELS, type Author, type NoteKind, type OpenSource, type PaperDetail } from "../lib/types";
import { formatDate } from "../lib/util";
import { useField } from "../store";
import { Button, Empty, Field } from "./ui";

function NoteEditor({
  kind,
  paper,
}: {
  kind: NoteKind;
  paper: PaperDetail;
}) {
  const saveNote = useField((s) => s.saveNote);
  const block = paper.notes[kind];
  const [value, setValue] = useState(block.content);
  const [editing, setEditing] = useState(!block.content);

  useEffect(() => {
    setValue(block.content);
    setEditing(!block.content);
  }, [block.content, paper.id, kind]);

  const label = NOTE_LABELS[kind];
  return (
    <section className="ef-note-block" id={`note-${kind}`}>
      <header>
        <h3>
          <span>{label.en.slice(0, 2)}</span>
          {label.zh} / {label.en}
        </h3>
        <div className="ef-note-head">
          <span>
            SRC {block.source.toUpperCase()}
            {block.userEdited ? " · EDITED" : ""}
          </span>
          <button type="button" className="ef-btn" onClick={() => setEditing((v) => !v)}>
            {editing ? "PREVIEW" : "EDIT"}
          </button>
        </div>
      </header>
      {editing ? (
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            if (value !== block.content) void saveNote(kind, value);
          }}
          aria-label={label.zh}
        />
      ) : (
        <div
          className="ef-md"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(value || "_empty_") }}
        />
      )}
    </section>
  );
}

export function ReadingStage() {
  const paper = useField((s) => s.paper);
  const mode = useField((s) => s.mode);
  const jobs = useField((s) => s.jobs);
  const settings = useField((s) => s.settings);
  const markRead = useField((s) => s.markRead);
  const markReading = useField((s) => s.markReading);
  const runPrepareMeta = useField((s) => s.runPrepareMeta);
  const runDraftNotes = useField((s) => s.runDraftNotes);
  const cancelJob = useField((s) => s.cancelJob);
  const savePaperPatch = useField((s) => s.savePaperPatch);
  const saveAuthors = useField((s) => s.saveAuthors);
  const deletePaper = useField((s) => s.deletePaper);
  const openDialog = useField((s) => s.openDialog);
  const selectPaper = useField((s) => s.selectPaper);

  if (!paper) {
    return (
      <section className="ef-read" id="stage" aria-labelledby="read-empty">
        <div className="ef-read-grid" aria-hidden="true" />
        <div className="ef-read-surface">
          <Empty
            title="Select a paper"
            body="从左侧导航选择一篇论文，在此阅读摘要并撰写现场笔记。笔记与总结是主舞台，不是侧栏。"
            action={
              mode === "field" ? (
                <Button primary type="button" onClick={() => openDialog("paper")}>
                  + PAPER
                </Button>
              ) : null
            }
          />
        </div>
      </section>
    );
  }

  const active = jobs.filter(
    (job) => job.paperId === paper.id && (job.status === "running" || job.status === "queued"),
  );
  const labs = paper.labs.length
    ? paper.labs
    : [...new Set(paper.authors.map((a) => a.lab).filter(Boolean))].map((name) => ({
        name: name as string,
        institution: paper.authors.find((a) => a.lab === name)?.affiliation ?? "",
      }));

  return (
    <section className="ef-read" id="stage" aria-labelledby="read-title">
      <div className="ef-read-grid" aria-hidden="true" />
      <div className="ef-read-bar">
        <button type="button" className="ef-btn ef-list-back" onClick={() => void selectPaper(null)}>
          ← LIST
        </button>
        {paper.readingStatus === "read" ? (
          <Button type="button" onClick={() => void markReading()}>
            READ · {formatDate(paper.readAt)} · UNDO
          </Button>
        ) : (
          <Button primary type="button" onClick={() => void markRead()}>
            MARK READ
          </Button>
        )}
        {paper.readingStatus === "unread" ? (
          <Button type="button" onClick={() => void markReading()}>
            SET READING
          </Button>
        ) : null}
        <Button type="button" onClick={() => void runPrepareMeta(paper.id)} disabled={Boolean(active.length)}>
          LLM PREPARE
        </Button>
        <Button type="button" onClick={() => void runDraftNotes(paper.id)} disabled={Boolean(active.length)}>
          DRAFT NOTES
        </Button>
        {active.map((job) => (
          <span key={job.id} className="ef-job-live">
            <i className="ef-pulse" aria-hidden="true" />
            {job.type} · {job.status}
            <Button type="button" onClick={() => void cancelJob(job.id)}>
              CANCEL
            </Button>
          </span>
        ))}
        <span className="ef-read-bar-spacer" />
        <Button type="button" onClick={() => openDialog("edit-domain")}>
          MOVE
        </Button>
        <Button type="button" onClick={() => void deletePaper()}>
          DELETE
        </Button>
      </div>

      <div className="ef-read-surface">
        <p className="ef-kicker">
          {paper.domain.code} · {paper.readingStatus.toUpperCase()}
          {paper.llmPreparedAt ? " · META READY" : ""}
        </p>
        <h1 className="ef-read-title" id="read-title">
          {paper.titleZh || paper.title}
        </h1>
        {paper.titleZh ? <p className="ef-read-en">{paper.title}</p> : null}
        <p className="ef-read-meta">
          {[paper.venue, paper.year, paper.arxivId ? `arXiv:${paper.arxivId}` : null, paper.doi]
            .filter(Boolean)
            .join(" · ")}
        </p>

        {!settings.hasKey ? (
          <p className="ef-read-banner">NO KEY / 在 SYSTEM 写入端点后可 PREPARE。可完整手录。LLM 不会标记已读。</p>
        ) : null}

        <section className="ef-abstract">
          <h2>ABSTRACT / 概要</h2>
          <p>{paper.abstract || "尚无摘要。展开 META 或运行 LLM PREPARE。"}</p>
        </section>

        <div className="ef-band">
          <div>
            <h2>CREW / LAB</h2>
            <p>
              {paper.authors.length
                ? paper.authors
                    .map((a) => `${a.name}${a.lab ? ` (${a.lab})` : a.affiliation ? ` (${a.affiliation})` : ""}`)
                    .join(" · ")
                : "无作者记录"}
            </p>
            {labs.length ? (
              <p className="ef-band-muted">{labs.map((l) => [l.name, l.institution].filter(Boolean).join(" · ")).join(" / ")}</p>
            ) : null}
          </div>
          <div>
            <h2>ARTIFACTS</h2>
            <div className="ef-artifacts">
              {paper.pdfUrl ? (
                <a className="ef-chip-link" href={paper.pdfUrl} target="_blank" rel="noreferrer">
                  PDF
                </a>
              ) : (
                <span className="ef-chip unknown">NO PDF</span>
              )}
              {paper.codeUrl ? (
                <a className="ef-chip-link" href={paper.codeUrl} target="_blank" rel="noreferrer">
                  CODE
                </a>
              ) : (
                <span className="ef-chip unknown">NO CODE</span>
              )}
              {paper.projectPage ? (
                <a className="ef-chip-link" href={paper.projectPage} target="_blank" rel="noreferrer">
                  PROJECT
                </a>
              ) : null}
              <label className="ef-os-select">
                <span>OPEN SRC</span>
                <select
                  value={paper.codeOpenSource}
                  onChange={(e) => void savePaperPatch({ codeOpenSource: e.target.value as OpenSource })}
                  aria-label="Open source status"
                >
                  <option value="unknown">unknown</option>
                  <option value="open">open</option>
                  <option value="closed">closed</option>
                  <option value="request">request</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        <details className="ef-meta-fold">
          <summary>META / CREW · 校对元数据与作者（次于笔记）</summary>
          <MetaEditor paper={paper} onSave={(patch) => void savePaperPatch(patch)} />
          <CrewEditor authors={paper.authors} onSave={(next) => void saveAuthors(next)} />
        </details>

        <header className="ef-notes-head">
          <h2>FIELD NOTES / 现场笔记</h2>
          <p>Markdown。LLM 预填标记 source=llm；你改过之后不会被静默覆盖。</p>
        </header>
        {NOTE_KINDS.map((kind) => (
          <NoteEditor key={kind} kind={kind} paper={paper} />
        ))}
      </div>
    </section>
  );
}

function MetaEditor({
  paper,
  onSave,
}: {
  paper: PaperDetail;
  onSave: (patch: {
    title?: string;
    titleZh?: string | null;
    abstract?: string;
    year?: number | null;
    venue?: string | null;
    doi?: string | null;
    arxivId?: string | null;
    pdfUrl?: string | null;
    codeUrl?: string | null;
    projectPage?: string | null;
    tags?: string[];
  }) => void;
}) {
  const [draft, setDraft] = useState({
    title: paper.title,
    titleZh: paper.titleZh ?? "",
    abstract: paper.abstract,
    year: paper.year?.toString() ?? "",
    venue: paper.venue ?? "",
    doi: paper.doi ?? "",
    arxivId: paper.arxivId ?? "",
    pdfUrl: paper.pdfUrl ?? "",
    codeUrl: paper.codeUrl ?? "",
    projectPage: paper.projectPage ?? "",
    tags: paper.tags.join(", "),
  });

  useEffect(() => {
    setDraft({
      title: paper.title,
      titleZh: paper.titleZh ?? "",
      abstract: paper.abstract,
      year: paper.year?.toString() ?? "",
      venue: paper.venue ?? "",
      doi: paper.doi ?? "",
      arxivId: paper.arxivId ?? "",
      pdfUrl: paper.pdfUrl ?? "",
      codeUrl: paper.codeUrl ?? "",
      projectPage: paper.projectPage ?? "",
      tags: paper.tags.join(", "),
    });
  }, [paper]);

  return (
    <div className="ef-meta-form">
      <Field light label="Title">
        <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      </Field>
      <Field light label="Chinese title">
        <input value={draft.titleZh} onChange={(e) => setDraft({ ...draft, titleZh: e.target.value })} />
      </Field>
      <Field light label="Abstract">
        <textarea value={draft.abstract} onChange={(e) => setDraft({ ...draft, abstract: e.target.value })} />
      </Field>
      <Field light label="Year">
        <input value={draft.year} onChange={(e) => setDraft({ ...draft, year: e.target.value })} />
      </Field>
      <Field light label="Venue">
        <input value={draft.venue} onChange={(e) => setDraft({ ...draft, venue: e.target.value })} />
      </Field>
      <Field light label="DOI">
        <input value={draft.doi} onChange={(e) => setDraft({ ...draft, doi: e.target.value })} />
      </Field>
      <Field light label="arXiv">
        <input value={draft.arxivId} onChange={(e) => setDraft({ ...draft, arxivId: e.target.value })} />
      </Field>
      <Field light label="PDF">
        <input value={draft.pdfUrl} onChange={(e) => setDraft({ ...draft, pdfUrl: e.target.value })} />
      </Field>
      <Field light label="Code">
        <input value={draft.codeUrl} onChange={(e) => setDraft({ ...draft, codeUrl: e.target.value })} />
      </Field>
      <Field light label="Project">
        <input value={draft.projectPage} onChange={(e) => setDraft({ ...draft, projectPage: e.target.value })} />
      </Field>
      <Field light label="Tags">
        <input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
      </Field>
      <Button
        primary
        type="button"
        onClick={() =>
          onSave({
            title: draft.title,
            titleZh: draft.titleZh || null,
            abstract: draft.abstract,
            year: draft.year ? Number(draft.year) : null,
            venue: draft.venue || null,
            doi: draft.doi || null,
            arxivId: draft.arxivId || null,
            pdfUrl: draft.pdfUrl || null,
            codeUrl: draft.codeUrl || null,
            projectPage: draft.projectPage || null,
            tags: draft.tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          })
        }
      >
        SAVE META
      </Button>
    </div>
  );
}

function CrewEditor({
  authors,
  onSave,
}: {
  authors: Author[];
  onSave: (authors: Author[]) => void;
}) {
  const [draft, setDraft] = useState(authors);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setDraft(authors);
    setEditing(false);
  }, [authors]);

  if (!editing) {
    return (
      <div className="ef-crew">
        {authors.length === 0 ? <p>无作者记录</p> : null}
        {authors.map((author) => (
          <article key={author.id}>
            <strong>
              {author.name}
              {author.isCorresponding ? " · CORR" : ""}
            </strong>
            <small>{[author.affiliation, author.lab].filter(Boolean).join(" / ") || "unaffiliated"}</small>
          </article>
        ))}
        <Button type="button" onClick={() => setEditing(true)}>
          EDIT CREW
        </Button>
      </div>
    );
  }

  return (
    <div>
      {draft.map((author, index) => (
        <div key={author.id} className="ef-crew-edit">
          <Field light label={`Author ${index + 1}`}>
            <input
              value={author.name}
              onChange={(e) => {
                const next = [...draft];
                next[index] = { ...author, name: e.target.value };
                setDraft(next);
              }}
            />
          </Field>
          <Field light label="Affiliation">
            <input
              value={author.affiliation ?? ""}
              onChange={(e) => {
                const next = [...draft];
                next[index] = { ...author, affiliation: e.target.value };
                setDraft(next);
              }}
            />
          </Field>
          <Field light label="Lab">
            <input
              value={author.lab ?? ""}
              onChange={(e) => {
                const next = [...draft];
                next[index] = { ...author, lab: e.target.value };
                setDraft(next);
              }}
            />
          </Field>
          <label>
            <input
              type="checkbox"
              checked={author.isCorresponding}
              onChange={(e) => {
                const next = [...draft];
                next[index] = { ...author, isCorresponding: e.target.checked };
                setDraft(next);
              }}
            />{" "}
            corresponding
          </label>
        </div>
      ))}
      <div className="job-row">
        <Button
          type="button"
          onClick={() =>
            setDraft([
              ...draft,
              {
                id: crypto.randomUUID(),
                name: "",
                nameZh: null,
                affiliation: "",
                lab: "",
                homepage: null,
                orcid: null,
                order: draft.length,
                isCorresponding: false,
              },
            ])
          }
        >
          + AUTHOR
        </Button>
        <Button primary type="button" onClick={() => onSave(draft.filter((a) => a.name.trim()))}>
          SAVE CREW
        </Button>
      </div>
    </div>
  );
}
