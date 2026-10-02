import { useEffect, useState } from "react";
import { listPdfs, normalizePdf } from "../lib/mineru";
import { repo } from "../lib/repo";
import type { Author, PaperDetail } from "../lib/types";
import { isTauri } from "../lib/util";
import { useField } from "../store";
import { Button, Dialog, Field, Icon } from "./ui";

export function PaperDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const importPdfs = useField((s) => s.importPdfs);
  const [items, setItems] = useState<Array<{ path: string; name: string; duplicate: boolean }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const open = dialog === "paper";

  useEffect(() => {
    if (!open) return;
    setItems([]);
    setError(null);
    setBusy(false);
    setProgress(null);
    setManualOpen(false);
  }, [open]);

  async function addPaths(paths: string[]) {
    const known = new Set(await repo.pdfPaths());
    setItems((current) => {
      const next = new Map(current.map((item) => [item.path, item]));
      for (const path of paths) {
        const name = path.split(/[/\\]/).pop() ?? path;
        next.set(path, { path, name, duplicate: known.has(path) });
      }
      return [...next.values()];
    });
  }

  async function pickFiles() {
    setError(null);
    try {
      const { open: pick } = await import("@tauri-apps/plugin-dialog");
      const selected = await pick({
        multiple: true,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!selected) return;
      const list = Array.isArray(selected) ? selected : [selected];
      const normalized = [];
      for (const path of list) normalized.push(await normalizePdf(path));
      await addPaths(normalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function pickDirectory() {
    setError(null);
    try {
      const { open: pick } = await import("@tauri-apps/plugin-dialog");
      const selected = await pick({ directory: true, multiple: false });
      if (typeof selected !== "string") return;
      await addPaths(await listPdfs(selected));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const fresh = items.filter((item) => !item.duplicate);

  return (
    <Dialog
      open={open}
      title="导入 PDF"
      className="is-wide"
      onClose={closeDialog}
      footer={
        <>
          <Button type="button" onClick={closeDialog}>
            取消
          </Button>
          <Button
            variant="primary"
            type="button"
            disabled={!fresh.length || busy}
            onClick={() => {
              setError(null);
              setBusy(true);
              void importPdfs(fresh.map((item) => item.path), (done, total, current) =>
                setProgress({ done, total, current }),
              )
                .catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : String(err));
                })
                .finally(() => {
                  setBusy(false);
                  setProgress(null);
                });
            }}
          >
            {busy ? "导入中…" : `导入 ${fresh.length ? fresh.length : ""}`}
          </Button>
        </>
      }
    >
      <p>选择本机 PDF，或一个目录中的全部 PDF。文件名会先当作标题，导入后立即交给 MinerU 解析。没有 PDF 时也可手动添加论文。</p>
      {isTauri() ? (
        <div className="ef-import-actions">
          <Button type="button" onClick={() => void pickFiles()} disabled={busy}>
            <Icon name="file" />
            选择 PDF
          </Button>
          <Button type="button" onClick={() => void pickDirectory()} disabled={busy}>
            <Icon name="inbox" />
            选择文件夹
          </Button>
          <Button
            type="button"
            className={manualOpen ? "is-active" : ""}
            aria-pressed={manualOpen}
            onClick={() => setManualOpen((value) => !value)}
            disabled={busy}
          >
            <Icon name="edit" />
            手动添加
          </Button>
        </div>
      ) : (
        <p>浏览器预览不能读取本机 PDF，仍可手动添加论文。完整导入请在桌面应用中进行。</p>
      )}
      {isTauri() && manualOpen ? <ManualPaperForm onCreated={() => setManualOpen(false)} /> : null}
      {!isTauri() ? <ManualPaperForm onCreated={() => undefined} /> : null}
      {busy && progress ? (
        <p aria-live="polite">
          正在导入 {progress.done}/{progress.total} · {progress.current}
        </p>
      ) : busy ? (
        <p aria-live="polite">正在导入…</p>
      ) : null}
      {items.length ? (
        <ul className="ef-import-list">
          {items.map((item) => (
            <li key={item.path}>
              <span>{item.name}</span>
              {item.duplicate ? <em>已在库中</em> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p style={{ color: "var(--pf-danger)" }}>{error}</p> : null}
    </Dialog>
  );
}

function ManualPaperForm({ onCreated }: { onCreated: () => void }) {
  const createManualPaper = useField((s) => s.createManualPaper);
  const [title, setTitle] = useState("");
  const [arxivId, setArxivId] = useState("");
  const [doi, setDoi] = useState("");
  const [pdfPath, setPdfPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pickPdf() {
    setError(null);
    try {
      const { open: pick } = await import("@tauri-apps/plugin-dialog");
      const selected = await pick({
        multiple: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (typeof selected !== "string") return;
      setPdfPath(await normalizePdf(selected));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const titleMissing = Boolean(busy === false && error && !title.trim());

  return (
    <div className="ef-manual-paper">
      <Field label="标题（必填）">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Attention Is All You Need"
          aria-invalid={titleMissing || undefined}
        />
      </Field>
      <Field label="arXiv ID">
        <input value={arxivId} onChange={(e) => setArxivId(e.target.value)} placeholder="1706.03762" />
      </Field>
      <Field label="DOI">
        <input value={doi} onChange={(e) => setDoi(e.target.value)} placeholder="10.1038/…" />
      </Field>
      {isTauri() ? (
        <Field label="本地 PDF（可选）">
          <div className="ef-import-actions" style={{ margin: 0 }}>
            <Button type="button" size="sm" onClick={() => void pickPdf()} disabled={busy}>
              <Icon name="file" />
              {pdfPath ? pdfPath.split(/[/\\]/).pop() : "选择 PDF"}
            </Button>
            {pdfPath ? (
              <Button type="button" size="sm" variant="text" onClick={() => setPdfPath("")} disabled={busy}>
                移除
              </Button>
            ) : null}
          </div>
        </Field>
      ) : null}
      <div className="ef-import-actions">
        <Button
          variant="primary"
          type="button"
          disabled={busy}
          onClick={() => {
            if (!title.trim()) {
              setError("标题必填。没有 PDF 也可以先建条目，之后可通过「编辑论文信息」补充。");
              return;
            }
            setError(null);
            setBusy(true);
            void createManualPaper({
              title,
              arxivId: arxivId || undefined,
              doi: doi || undefined,
              pdfPath: pdfPath || undefined,
            })
              .then(onCreated)
              .catch((err: unknown) => {
                setBusy(false);
                setError(err instanceof Error ? err.message : String(err));
              });
          }}
        >
          {busy ? "创建中…" : "创建论文"}
        </Button>
      </div>
      {error ? <p style={{ color: "var(--pf-danger)" }}>{error}</p> : null}
    </div>
  );
}

export function DomainDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const createDomain = useField((s) => s.createDomain);
  const updateDomain = useField((s) => s.updateDomain);
  const deleteDomain = useField((s) => s.deleteDomain);
  const domains = useField((s) => s.domains);
  const selectedDomainId = useField((s) => s.selectedDomainId);
  const current = domains.find((d) => d.id === selectedDomainId);
  const editing = dialog === "edit-domain";
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const open = dialog === "domain" || dialog === "edit-domain";

  useEffect(() => {
    if (!open) return;
    if (editing && current) {
      setName(current.name);
      setCode(current.code);
      setSummary(current.summary ?? "");
    } else if (!editing) {
      setName("");
      setCode("");
      setSummary("");
    }
    setError(null);
    setConfirmDelete(false);
  }, [open, editing, selectedDomainId]);

  return (
    <Dialog
      open={open}
      title={editing ? "编辑研究领域" : "新建研究领域"}
      onClose={closeDialog}
      danger={confirmDelete}
      footer={
        <>
          {editing ? (
            confirmDelete ? (
              <Button
                type="button"
                className="ef-btn-danger-solid"
                onClick={() => void deleteDomain()}
              >
                确认删除领域
              </Button>
            ) : (
              <Button type="button" variant="danger" onClick={() => setConfirmDelete(true)}>
                删除领域…
              </Button>
            )
          ) : null}
          <Button type="button" onClick={closeDialog}>
            取消
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={() => {
              setError(null);
              const run = editing
                ? updateDomain({ name, code, summary })
                : createDomain({ name, code, summary });
              void run.catch((err: unknown) =>
                setError(err instanceof Error ? err.message : String(err)),
              );
            }}
          >
            {editing ? "保存修改" : "创建领域"}
          </Button>
        </>
      }
    >
      {confirmDelete ? (
        <p>将删除「{current?.name}」及其中全部论文与笔记。此操作不可撤销。</p>
      ) : (
        <>
          <Field label="名称 / 中文">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="多模态"
              autoFocus
            />
          </Field>
          <Field label="短码">
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="MM-03" />
          </Field>
          <Field label="简介">
            <textarea value={summary} onChange={(e) => setSummary(e.target.value)} />
          </Field>
        </>
      )}
      {error ? <p style={{ color: "var(--pf-danger)" }}>{error}</p> : null}
    </Dialog>
  );
}

export function DomainPickerDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const domains = useField((s) => s.domains);
  const selectedDomainId = useField((s) => s.selectedDomainId);
  const selectDomain = useField((s) => s.selectDomain);
  const movePaper = useField((s) => s.movePaper);
  const openDialog = useField((s) => s.openDialog);
  const moving = dialog === "move-paper";
  const open = dialog === "pick-domain" || moving;

  return (
    <Dialog
      open={open}
      title={moving ? "移动到其他领域" : "切换研究领域"}
      onClose={closeDialog}
      footer={
        moving ? (
          <Button type="button" onClick={closeDialog}>
            取消
          </Button>
        ) : (
          <>
            <Button type="button" onClick={() => openDialog("edit-domain")}>
              编辑当前领域
            </Button>
            <Button type="button" variant="primary" onClick={() => openDialog("domain")}>
              <Icon name="plus" />
              新建领域
            </Button>
          </>
        )
      }
    >
      <p>{moving ? "选择这篇论文要进入的领域。" : "选择要查看的研究领域。"}</p>
      {domains.map((domain) => (
        <button
          key={domain.id}
          type="button"
          className={`ef-domain-option ${domain.id === selectedDomainId ? "is-current" : ""}`}
          onClick={() => {
            if (moving) void movePaper(domain.id);
            else void selectDomain(domain.id);
          }}
        >
          <span>
            <strong>{domain.name}</strong>
            {domain.summary ? (
              <small style={{ display: "block", color: "var(--pf-muted)", marginTop: 4 }}>
                {domain.summary}
              </small>
            ) : null}
          </span>
          <span className="mono">
            {domain.code} <Icon name="right" />
          </span>
        </button>
      ))}
    </Dialog>
  );
}

export function DeletePaperDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const paper = useField((s) => s.paper);
  const deletePaper = useField((s) => s.deletePaper);

  return (
    <Dialog
      open={dialog === "delete-paper"}
      title="删除这篇论文？"
      onClose={closeDialog}
      danger
      footer={
        <>
          <Button type="button" onClick={closeDialog}>
            取消
          </Button>
          <Button type="button" className="ef-btn-danger-solid" onClick={() => void deletePaper()}>
            确认删除
          </Button>
        </>
      }
    >
      <p>
        <strong>{paper?.titleZh || paper?.title}</strong>
      </p>
      <p>将删除这篇论文及其全部笔记。此操作不可撤销。</p>
    </Dialog>
  );
}

export function ConfirmNotesDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const pendingDraftJob = useField((s) => s.pendingDraftJob);
  const runDraftNotes = useField((s) => s.runDraftNotes);

  return (
    <Dialog
      open={dialog === "confirm-notes"}
      title="笔记已被修改"
      onClose={closeDialog}
      footer={
        <>
          <Button type="button" onClick={closeDialog}>
            保留我的笔记
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={() => void runDraftNotes(pendingDraftJob ?? undefined, true)}
          >
            用 AI 草稿覆盖
          </Button>
        </>
      }
    >
      <p>你已经修改过笔记，AI 不会静默覆盖。确认后五个笔记板块都会替换为 AI 草稿。</p>
    </Dialog>
  );
}

/** userMetaTouched 时的补全论文信息确认：AI 不会静默覆盖手动修改过的字段。 */
export function ConfirmMetaDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const paper = useField((s) => s.paper);
  const runPrepareMeta = useField((s) => s.runPrepareMeta);
  const open = dialog === "confirm-meta" && Boolean(paper);

  function run(overwrite: boolean) {
    closeDialog();
    if (paper) void runPrepareMeta(paper.id, overwrite);
  }

  return (
    <Dialog
      open={open}
      title="论文信息已被手动修改"
      onClose={closeDialog}
      footer={
        <>
          <Button type="button" onClick={() => run(false)}>
            保留我的修改
          </Button>
          <Button variant="primary" type="button" onClick={() => run(true)}>
            用 AI 结果覆盖
          </Button>
        </>
      }
    >
      <p>
        你已经手动修改过论文信息，AI 不会静默覆盖。「保留我的修改」只补全空白字段；
        「用 AI 结果覆盖」会覆盖你修改过的字段。
      </p>
    </Dialog>
  );
}

export function EditPaperDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const paper = useField((s) => s.paper);
  const savePaperPatch = useField((s) => s.savePaperPatch);
  const saveAuthors = useField((s) => s.saveAuthors);
  const setFlash = useField((s) => s.setFlash);
  const open = dialog === "edit-paper" && Boolean(paper);
  const [metaDirty, setMetaDirty] = useState(false);
  const [crewDirty, setCrewDirty] = useState(false);

  useEffect(() => {
    if (!open) {
      setMetaDirty(false);
      setCrewDirty(false);
    }
  }, [open]);

  // dirty 时否决关闭并提示；第二次 Esc / 关闭仍可放行（ui.tsx 的 hasVetoedOnce 约定）。
  function vetoClose(): boolean {
    if (metaDirty || crewDirty) {
      setFlash({ tone: "warn", text: "论文信息尚未保存。点击「保存论文信息」保存，或再按一次 Esc 放弃修改。" });
      return true;
    }
    return false;
  }

  return (
    <Dialog
      open={open}
      title="编辑论文信息"
      onClose={closeDialog}
      vetoClose={vetoClose}
      className="is-wide"
      footer={
        <Button type="button" onClick={closeDialog}>
          完成
        </Button>
      }
    >
      {paper ? (
        <>
          <MetaEditor
            paper={paper}
            onDirtyChange={setMetaDirty}
            onSave={(patch) => void savePaperPatch(patch)}
          />
          <h3 style={{ fontSize: 16, margin: "8px 0 12px" }}>作者</h3>
          <CrewEditor authors={paper.authors} onDirtyChange={setCrewDirty} onSave={(next) => void saveAuthors(next)} />
        </>
      ) : null}
    </Dialog>
  );
}

function metaDraftOf(paper: PaperDetail) {
  return {
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
  };
}

function MetaEditor({
  paper,
  onSave,
  onDirtyChange,
}: {
  paper: PaperDetail;
  onDirtyChange?: (dirty: boolean) => void;
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
  const [draft, setDraft] = useState(() => metaDraftOf(paper));

  useEffect(() => {
    setDraft(metaDraftOf(paper));
  }, [paper]);

  const base = metaDraftOf(paper);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // 年份校验：非空时必须是可解析的整数（此前 Number("abc") → NaN 会把年份写成 NaN）。
  const yearText = draft.year.trim();
  const parsedYear = yearText ? Number.parseInt(yearText, 10) : null;
  const yearInvalid = Boolean(yearText) && (parsedYear === null || !Number.isFinite(parsedYear));

  return (
    <div>
      <Field label="英文标题">
        <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      </Field>
      <Field label="中文标题">
        <input value={draft.titleZh} onChange={(e) => setDraft({ ...draft, titleZh: e.target.value })} />
      </Field>
      <Field label="摘要">
        <textarea value={draft.abstract} onChange={(e) => setDraft({ ...draft, abstract: e.target.value })} />
      </Field>
      <Field label="年份">
        <input
          value={draft.year}
          onChange={(e) => setDraft({ ...draft, year: e.target.value })}
          inputMode="numeric"
          aria-invalid={yearInvalid || undefined}
        />
      </Field>
      {yearInvalid ? (
        <p style={{ color: "var(--pf-danger)", margin: "-10px 0 12px", fontSize: 13 }}>
          年份需为数字，例如 2024。当前输入不会被保存。
        </p>
      ) : null}
      <Field label="会议 / 期刊">
        <input value={draft.venue} onChange={(e) => setDraft({ ...draft, venue: e.target.value })} />
      </Field>
      <Field label="DOI">
        <input value={draft.doi} onChange={(e) => setDraft({ ...draft, doi: e.target.value })} />
      </Field>
      <Field label="arXiv">
        <input value={draft.arxivId} onChange={(e) => setDraft({ ...draft, arxivId: e.target.value })} />
      </Field>
      <Field label="本地 PDF">
        <input value={paper.pdfPath ?? "尚未关联本地 PDF"} readOnly />
      </Field>
      <Field label="公开 PDF 链接">
        <input value={draft.pdfUrl} onChange={(e) => setDraft({ ...draft, pdfUrl: e.target.value })} />
      </Field>
      <Field label="代码仓库">
        <input value={draft.codeUrl} onChange={(e) => setDraft({ ...draft, codeUrl: e.target.value })} />
      </Field>
      <Field label="项目主页">
        <input value={draft.projectPage} onChange={(e) => setDraft({ ...draft, projectPage: e.target.value })} />
      </Field>
      <Field label="标签">
        <input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
      </Field>
      <Button
        variant="primary"
        type="button"
        disabled={yearInvalid}
        onClick={() =>
          onSave({
            title: draft.title,
            titleZh: draft.titleZh || null,
            abstract: draft.abstract,
            year: yearText && parsedYear !== null && Number.isFinite(parsedYear) ? parsedYear : null,
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
        保存论文信息
      </Button>
    </div>
  );
}

function CrewEditor({
  authors,
  onSave,
  onDirtyChange,
}: {
  authors: Author[];
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (authors: Author[]) => void;
}) {
  const [draft, setDraft] = useState(authors);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setDraft(authors);
    setEditing(false);
  }, [authors]);

  const crewDirty =
    editing && (draft.length !== authors.length || JSON.stringify(draft) !== JSON.stringify(authors));

  useEffect(() => {
    onDirtyChange?.(crewDirty);
  }, [crewDirty, onDirtyChange]);

  if (!editing) {
    return (
      <div className="ef-crew">
        {authors.length === 0 ? <p>无作者记录</p> : null}
        {authors.map((author) => (
          <article key={author.id}>
            <strong>
              {author.name}
              {author.isCorresponding ? " · 通讯" : ""}
            </strong>
            <small>{[author.affiliation, author.lab].filter(Boolean).join(" / ") || "机构待补充"}</small>
          </article>
        ))}
        <Button type="button" onClick={() => setEditing(true)}>
          编辑作者
        </Button>
      </div>
    );
  }

  return (
    <div>
      {draft.map((author, index) => (
        <div key={author.id} className="ef-crew-edit">
          <Field label={`作者 ${index + 1}`}>
            <input
              value={author.name}
              onChange={(e) => {
                const next = [...draft];
                next[index] = { ...author, name: e.target.value };
                setDraft(next);
              }}
            />
          </Field>
          <Field label="机构">
            <input
              value={author.affiliation ?? ""}
              onChange={(e) => {
                const next = [...draft];
                next[index] = { ...author, affiliation: e.target.value };
                setDraft(next);
              }}
            />
          </Field>
          <Field label="实验室">
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
            通讯作者
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
          添加作者
        </Button>
        <Button variant="primary" type="button" onClick={() => onSave(draft.filter((a) => a.name.trim()))}>
          保存作者
        </Button>
      </div>
    </div>
  );
}
