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
  const open = dialog === "paper";

  useEffect(() => {
    if (!open) return;
    setItems([]);
    setError(null);
    setBusy(false);
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
              void importPdfs(fresh.map((item) => item.path)).catch((err: unknown) => {
                setBusy(false);
                setError(err instanceof Error ? err.message : String(err));
              });
            }}
          >
            导入 {fresh.length ? fresh.length : ""}
          </Button>
        </>
      }
    >
      <p>选择本机 PDF，或一个目录中的全部 PDF。文件名会先当作标题，导入后立即交给 MinerU 4.0 解析。</p>
      {isTauri() ? (
        <div className="ef-import-actions">
          <Button type="button" onClick={() => void pickFiles()}>
            <Icon name="file" />
            选择 PDF
          </Button>
          <Button type="button" onClick={() => void pickDirectory()}>
            <Icon name="inbox" />
            选择文件夹
          </Button>
        </div>
      ) : (
        <p>浏览器预览不能读取本机 PDF。请在桌面应用中导入。</p>
      )}
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
        <p>将删除「{current?.name}」及其论文列表关联。此操作不可撤销。</p>
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
          <Field label="代码">
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
      <p>将删除这篇论文及其笔记。取消会安全返回，不会改动任何内容。</p>
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
      <p>你已经改过笔记。AI 不会静默覆盖。确认后五块现场笔记都会被起草阅读笔记替换。</p>
    </Dialog>
  );
}

export function EditPaperDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const paper = useField((s) => s.paper);
  const savePaperPatch = useField((s) => s.savePaperPatch);
  const saveAuthors = useField((s) => s.saveAuthors);
  const open = dialog === "edit-paper" && Boolean(paper);

  return (
    <Dialog
      open={open}
      title="编辑论文信息"
      onClose={closeDialog}
      className="is-wide"
      footer={
        <Button type="button" onClick={closeDialog}>
          完成
        </Button>
      }
    >
      {paper ? (
        <>
          <MetaEditor paper={paper} onSave={(patch) => void savePaperPatch(patch)} />
          <h3 style={{ fontSize: 16, margin: "8px 0 12px" }}>作者</h3>
          <CrewEditor authors={paper.authors} onSave={(next) => void saveAuthors(next)} />
        </>
      ) : null}
    </Dialog>
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
        <input value={draft.year} onChange={(e) => setDraft({ ...draft, year: e.target.value })} />
      </Field>
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
        <input value={paper.pdfPath ?? "未绑定本地文件"} readOnly />
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
        保存论文信息
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
              {author.isCorresponding ? " · 通讯" : ""}
            </strong>
            <small>{[author.affiliation, author.lab].filter(Boolean).join(" / ") || "未填写机构"}</small>
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
