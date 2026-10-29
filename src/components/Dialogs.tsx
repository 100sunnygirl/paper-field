import { useEffect, useRef, useState, type CSSProperties } from "react";
import { pickPdfFiles, pickPdfFolder } from "../lib/mineru";
import { repo } from "../lib/repo";
import { defaultNotePermit, restoreRowLabel, type NotePermit, type PartitionedTitles } from "../lib/readingHolds";
import { NOTE_DISPLAY_ORDER, NOTE_KINDS, NOTE_LABELS, type NoteKind, type Author, type PaperDetail } from "../lib/types";
import { isTauri } from "../lib/util";
import { shortReason, useField } from "../store";
import { Button, Dialog, Field, Icon } from "./ui";

export function ImportFailureList() {
  const failures = useField((s) => s.importFailures);
  const retryImportFailures = useField((s) => s.retryImportFailures);
  const dismissImportFailures = useField((s) => s.dismissImportFailures);
  const [checked, setChecked] = useState<string[]>([]);
  const visible = failures.map((row) => row.path).join("\n");

  useEffect(() => {
    const live = new Set(visible ? visible.split("\n") : []);
    setChecked((current) => {
      const next = current.filter((path) => live.has(path));
      return next.length === current.length ? current : next;
    });
  }, [visible]);

  if (!failures.length) return null;
  const selected = failures.filter((row) => checked.includes(row.path)).map((row) => row.path);

  return (
    <section className="ef-import-failures" aria-label="导入失败">
      <h2>导入失败</h2>
      <ul>
        {failures.map((row) => (
          <li key={row.path}>
            <label>
              <input
                type="checkbox"
                checked={checked.includes(row.path)}
                aria-label={row.name}
                onChange={(event) => {
                  setChecked((current) =>
                    event.target.checked ? [...current, row.path] : current.filter((path) => path !== row.path),
                  );
                }}
              />
              <span>{row.name}</span>
              <small>{shortReason(row.message)}</small>
            </label>
          </li>
        ))}
      </ul>
      <div className="ef-import-review-actions">
        <Button type="button" size="sm" disabled={!selected.length} onClick={() => void retryImportFailures(selected)}>
          重试所选
        </Button>
        <Button type="button" size="sm" disabled={!selected.length} onClick={() => dismissImportFailures(selected)}>
          移除
        </Button>
      </div>
    </section>
  );
}

export function PaperDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const importPdfs = useField((s) => s.importPdfs);
  const domains = useField((s) => s.domains);
  const [items, setItems] = useState<Array<{ path: string; name: string; duplicate: boolean; excluded: boolean }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [targetDomainId, setTargetDomainId] = useState<string | null>(null);
  const open = dialog === "paper";

  useEffect(() => {
    if (!open) return;
    setItems([]);
    setError(null);
    setBusy(false);
    setProgress(null);
    setManualOpen(false);
    setTargetDomainId(useField.getState().selectedDomainId);
  }, [open]);

  async function addPaths(paths: string[]) {
    const known = new Set(await repo.pdfPaths());
    setItems((current) => {
      const next = new Map(current.map((item) => [item.path, item]));
      for (const path of paths) {
        const name = path.split(/[/\\]/).pop() ?? path;
        // 重新扫描同一目录时保留用户已排除的选择，不悄悄改回勾选。
        const excluded = current.find((item) => item.path === path)?.excluded ?? false;
        next.set(path, { path, name, duplicate: known.has(path), excluded });
      }
      return [...next.values()];
    });
  }

  async function pickFiles() {
    setError(null);
    try {
      // 对话框由 Rust 弹出并返回规范化路径；导入时后端只认这些路径。
      const selected = await pickPdfFiles(true);
      if (!selected) return;
      await addPaths(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function pickDirectory() {
    setError(null);
    try {
      const found = await pickPdfFolder();
      if (!found) return;
      await addPaths(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const fresh = items.filter((item) => !item.duplicate && !item.excluded);
  const checkable = items.filter((item) => !item.duplicate);
  const checkedCount = checkable.filter((item) => !item.excluded).length;

  function toggleExcluded(path: string, excluded: boolean) {
    setItems((current) => current.map((item) => (item.path === path ? { ...item, excluded } : item)));
  }

  function setAllExcluded(excluded: boolean) {
    setItems((current) => current.map((item) => (item.duplicate ? item : { ...item, excluded })));
  }

  return (
    <Dialog
      open={open}
      title={items.length === 0 ? "添加论文" : "导入 PDF"}
      className="is-wide"
      onClose={closeDialog}
      footer={
        <>
          <Button type="button" onClick={closeDialog}>
            取消
          </Button>
          {fresh.length > 0 ? (
            <Button
              variant="primary"
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null);
                setBusy(true);
                void importPdfs(
                  fresh.map((item) => item.path),
                  (done, total, current) => setProgress({ done, total, current }),
                  targetDomainId ?? undefined,
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
              {busy ? "导入中…" : `导入 ${fresh.length}`}
            </Button>
          ) : null}
        </>
      }
    >
      <p>
        选择本机 PDF，或一个目录中的全部 PDF（只读所选目录本身，不进入子目录）。加入后先在下方清单里勾选，排除不是论文的
        PDF，再完成导入。文件名会先当作标题，导入后立即交给 MinerU 解析。没有 PDF 时也可手动添加论文。
      </p>
      <Field label="导入到">
        <select aria-label="导入到" value={targetDomainId ?? ""} onChange={(event) => setTargetDomainId(event.target.value)}>
          {domains.map((domain) => (
            <option key={domain.id} value={domain.id}>
              {domain.name}
            </option>
          ))}
        </select>
      </Field>
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
      {isTauri() && manualOpen ? (
        <ManualPaperForm primary={fresh.length === 0} onCreated={() => setManualOpen(false)} />
      ) : null}
      {!isTauri() ? <ManualPaperForm primary onCreated={() => undefined} /> : null}
      {busy ? (
        <>
          {/* 装饰性扫动条：仅加载期间存在，3px 高，伴随文字状态不替代。 */}
          <div className="pf-sweep" aria-hidden="true" />
          {progress ? (
            <p aria-live="polite">
              正在导入 {progress.done}/{progress.total} · {progress.current}
            </p>
          ) : (
            <p aria-live="polite">正在导入…</p>
          )}
        </>
      ) : null}
      {items.length ? (
        <>
          <div className="ef-import-review-bar">
            <span>
              共 {checkable.length} 个待选，已勾选 {checkedCount} 个；取消勾选可在导入前排除非论文 PDF。
            </span>
            <span className="ef-import-review-actions">
              <Button
                type="button"
                size="sm"
                variant="text"
                disabled={busy || checkedCount === checkable.length}
                onClick={() => setAllExcluded(false)}
              >
                全选
              </Button>
              <Button
                type="button"
                size="sm"
                variant="text"
                disabled={busy || checkedCount === 0}
                onClick={() => setAllExcluded(true)}
              >
                全不选
              </Button>
            </span>
          </div>
          <ul className="ef-import-list">
            {items.map((item, index) => (
              <li
                key={item.path}
                className={`pf-stagger${item.excluded && !item.duplicate ? " is-excluded" : ""}`}
                style={{ "--pf-i": index } as CSSProperties}
              >
                <label className="ef-import-check">
                  <input
                    type="checkbox"
                    checked={!item.duplicate && !item.excluded}
                    disabled={busy || item.duplicate}
                    onChange={(e) => toggleExcluded(item.path, !e.target.checked)}
                  />
                  <span>{item.name}</span>
                </label>
                {item.duplicate ? <em>已在库中</em> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {error ? <p className="ef-error">{error}</p> : null}
    </Dialog>
  );
}

function ManualPaperForm({ onCreated, primary = false }: { onCreated: () => void; primary?: boolean }) {
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
      const selected = await pickPdfFiles(false);
      if (!selected?.[0]) return;
      setPdfPath(selected[0]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const titleMissing = Boolean(busy === false && error && !title.trim());

  return (
    <div className="ef-manual-paper pf-enter">
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
          <div className="ef-import-actions is-inline">
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
          variant={primary ? "primary" : "secondary"}
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
      {error ? <p className="ef-error">{error}</p> : null}
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
        confirmDelete ? (
          <>
            <Button type="button" onClick={closeDialog}>
              取消
            </Button>
            <Button type="button" className="ef-btn-danger-solid" onClick={() => void deleteDomain()}>
              确认删除领域
            </Button>
          </>
        ) : (
          <>
            {editing ? (
              <Button type="button" variant="danger" onClick={() => setConfirmDelete(true)}>
                删除领域…
              </Button>
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
        )
      }
    >
      {confirmDelete ? (
        <p>将删除「{current?.name}」及其中全部论文与笔记。此操作不可撤销。</p>
      ) : (
        <>
          <Field label="名称 / 中文（必填）">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="多模态"
              autoFocus
            />
          </Field>
          <Field label="短码（可选）">
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="留空自动生成，如 MM-03" />
          </Field>
          <Field label="简介（可选）">
            <textarea value={summary} onChange={(e) => setSummary(e.target.value)} />
          </Field>
        </>
      )}
      {error ? <p className="ef-error">{error}</p> : null}
    </Dialog>
  );
}

/**
 * 论文对话框的目标：打开时锁定的那篇（dialogPaperId）。通常就是当前论文；万一选中变了，
 * 就按 id 单独读出这篇，绝不改用别的论文。目标已被删除时 missing 为 true。
 */
function useDialogPaper(): { paper: PaperDetail | null; missing: boolean } {
  const dialogPaperId = useField((s) => s.dialogPaperId);
  const current = useField((s) => s.paper);
  const [loaded, setLoaded] = useState<{ id: string; paper: PaperDetail | null } | null>(null);
  // 上一次拿到的这篇：按 id 重读期间沿用它，编辑器不卸载，未保存的修改不丢。
  const last = useRef<PaperDetail | null>(null);
  const matches = Boolean(dialogPaperId) && current?.id === dialogPaperId;
  useEffect(() => {
    if (!dialogPaperId || matches) {
      // 选中回到这篇：丢掉旧的按 id 读取结果，下次改走时不会先拿到过期内容。
      setLoaded(null);
      return;
    }
    let alive = true;
    void repo.getPaper(dialogPaperId).then((paper) => {
      if (alive) setLoaded({ id: dialogPaperId, paper });
    });
    return () => {
      alive = false;
    };
  }, [dialogPaperId, matches]);
  if (!dialogPaperId) return { paper: null, missing: false };
  let paper: PaperDetail | null = null;
  let missing = false;
  if (matches) paper = current;
  else if (loaded?.id === dialogPaperId) {
    paper = loaded.paper;
    missing = loaded.paper === null;
  } else if (last.current?.id === dialogPaperId) paper = last.current;
  if (paper) last.current = paper;
  return { paper, missing };
}

/** 目标论文已被删除：关掉对话框并说明，不把操作转到别的论文上。 */
function useCloseWhenMissing(open: boolean, missing: boolean) {
  const closeDialog = useField((s) => s.closeDialog);
  const setFlash = useField((s) => s.setFlash);
  useEffect(() => {
    if (open && missing) {
      closeDialog();
      setFlash({ tone: "warn", text: "这篇论文已不存在，对话框已关闭。" });
    }
  }, [open, missing, closeDialog, setFlash]);
}

export function DomainPickerDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const domains = useField((s) => s.domains);
  const selectedDomainId = useField((s) => s.selectedDomainId);
  const selectDomain = useField((s) => s.selectDomain);
  const movePapers = useField((s) => s.movePapers);
  const openDialog = useField((s) => s.openDialog);
  const dialogPaperId = useField((s) => s.dialogPaperId);
  const dialogPaperIds = useField((s) => s.dialogPaperIds);
  const batchMove = dialog === "move-checked";
  const moving = dialog === "move-paper" || batchMove;
  const moveIds = batchMove ? dialogPaperIds : dialogPaperId ? [dialogPaperId] : [];
  const open = dialog === "pick-domain" || moving;
  const [domainName, setDomainName] = useState("");
  const [moveError, setMoveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDomainName("");
    setMoveError(null);
  }, [open]);

  return (
    <Dialog
      open={open}
      title={batchMove ? "移动到领域" : moving ? "移动到其他领域" : "切换研究领域"}
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
      <p>
        {batchMove ? "选择这些论文要进入的领域。" : moving ? "选择这篇论文要进入的领域。" : "选择要查看的研究领域。"}
      </p>
      {moving ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setMoveError(null);
            void movePapers(moveIds, { kind: "create", name: domainName }).catch((err: unknown) =>
              setMoveError(err instanceof Error ? err.message : String(err)),
            );
          }}
        >
          <Field label="新领域名称">
            <input
              aria-label="新领域名称"
              value={domainName}
              onChange={(event) => setDomainName(event.target.value)}
              placeholder="例如：对齐"
            />
          </Field>
          <Button type="submit" variant="primary">
            创建并移入
          </Button>
          {moveError ? <p className="ef-error">{moveError}</p> : null}
        </form>
      ) : null}
      {domains.map((domain) => (
        <button
          key={domain.id}
          type="button"
          className={`ef-domain-option ${domain.id === selectedDomainId ? "is-current" : ""}`}
          onClick={() => {
            if (moving) void movePapers(moveIds, { kind: "domain", domainId: domain.id });
            else void selectDomain(domain.id);
          }}
        >
          <span>
            <strong>{domain.name}</strong>
            {domain.summary ? (
              <small className="ef-domain-option-sum">
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
  const deletePaper = useField((s) => s.deletePaper);
  const { paper, missing } = useDialogPaper();
  const open = dialog === "delete-paper";
  const [busy, setBusy] = useState(false);
  useCloseWhenMissing(open, missing);

  async function confirm() {
    if (!paper || busy) return;
    setBusy(true);
    try {
      await deletePaper(paper.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open && Boolean(paper)}
      title="删除这篇论文？"
      onClose={closeDialog}
      danger
      footer={
        <>
          <Button type="button" onClick={closeDialog}>
            取消
          </Button>
          <Button type="button" className="ef-btn-danger-solid" disabled={busy} onClick={() => void confirm()}>
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

/** 批量模式下的删除确认：与单篇删除同构，只报数量不逐篇列名（数量即用户刚勾选的结果）。 */
export function DeleteCheckedPapersDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  // 打开时冻结的那批：确认期间后台刷新改动勾选集也不影响要删的论文与数量。
  const checkedPaperIds = useField((s) => s.dialogPaperIds);
  const deleteCheckedPapers = useField((s) => s.deleteCheckedPapers);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    try {
      await deleteCheckedPapers();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={dialog === "delete-checked" && checkedPaperIds.length > 0}
      title="删除选中的论文？"
      onClose={closeDialog}
      danger
      footer={
        <>
          <Button type="button" onClick={closeDialog}>
            取消
          </Button>
          <Button type="button" className="ef-btn-danger-solid" disabled={busy} onClick={() => void confirm()}>
            确认删除
          </Button>
        </>
      }
    >
      <p>
        将删除选中的 <strong>{checkedPaperIds.length}</strong> 篇论文及其全部笔记。此操作不可撤销。
      </p>
    </Dialog>
  );
}

export function ConfirmNotesDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const runDraftNotes = useField((s) => s.runDraftNotes);
  const drafts = useField((s) => s.drafts);
  const { paper, missing } = useDialogPaper();
  const open = dialog === "confirm-notes";
  useCloseWhenMissing(open, missing);
  const [checked, setChecked] = useState<NotePermit | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !paper) return;
    setChecked(defaultNotePermit(paper.notes, drafts[paper.id] ?? {}));
    setBusy(false);
  }, [open, paper?.id]);

  function submit() {
    if (!paper || !checked || busy) return;
    const openDrafts = useField.getState().drafts[paper.id] ?? {};
    const next: NotePermit = { ...checked };
    for (const kind of NOTE_KINDS) {
      if (openDrafts[kind] !== undefined) (next as { [K in NoteKind]: boolean })[kind] = false;
    }
    setBusy(true);
    void runDraftNotes(paper.id, next).finally(() => setBusy(false));
  }

  const plan = paper ? defaultNotePermit(paper.notes, drafts[paper.id] ?? {}) : null;
  const canSubmit = Boolean(plan && checked && NOTE_DISPLAY_ORDER.some((kind) => plan[kind] && checked[kind]));

  return (
    <Dialog
      open={open && Boolean(paper)}
      title="起草哪些笔记"
      onClose={closeDialog}
      footer={
        <>
          <Button type="button" onClick={closeDialog}>
            取消
          </Button>
          <Button variant="primary" type="button" disabled={busy || !canSubmit} onClick={submit}>
            起草所选
          </Button>
        </>
      }
    >
      <p>勾选允许模型写入的块。你改过的块，以及还没保存的草稿，默认不写入。</p>
      {paper && checked
        ? NOTE_DISPLAY_ORDER.map((kind) => {
            const editable = plan?.[kind] === true;
            const hint = drafts[paper.id]?.[kind] !== undefined ? "有未保存草稿" : paper.notes[kind].userEdited ? "已有人工修订" : null;
            return (
              <label key={kind}>
                <input
                  type="checkbox"
                  checked={editable && checked[kind]}
                  disabled={!editable}
                  onChange={(event) => setChecked((cur) => (cur ? { ...cur, [kind]: event.target.checked } : cur))}
                />
                {NOTE_LABELS[kind].zh}
                {hint ? <small> {hint}</small> : null}
              </label>
            );
          })
        : null}
    </Dialog>
  );
}

export function RestoreDiffDialog() {
  const dialog = useField((s) => s.dialog);
  const preview = useField((s) => s.restorePreview);
  const confirmRestore = useField((s) => s.confirmRestore);
  const cancelRestore = useField((s) => s.cancelRestore);
  const open = dialog === "restore-diff" && preview.phase !== "idle";
  const diff: PartitionedTitles | null = preview.phase === "idle" ? null : preview.diff;
  const columns = diff
    ? ([
        ["仅当前文库", diff.onlyCurrent],
        ["仅备份", diff.onlyBackup],
        ["两边都有", diff.both],
      ] as const)
    : [];

  return (
    <Dialog
      open={open}
      title="恢复前的文献"
      danger
      onClose={() => void cancelRestore()}
      footer={
        <>
          <Button type="button" onClick={() => void cancelRestore()}>
            取消
          </Button>
          <Button type="button" variant="primary" disabled={preview.phase !== "previewed"} onClick={() => void confirmRestore()}>
            恢复并重启
          </Button>
        </>
      }
    >
      {columns.map(([label, bucket]) => (
        <section key={label}>
          <h3>
            {label}（{bucket.rows.length + bucket.hidden}）
          </h3>
          <ul>
            {bucket.rows.map((row) => (
              <li key={row.id}>
                {restoreRowLabel(row)}
              </li>
            ))}
          </ul>
          {bucket.hidden ? <p>另有 {bucket.hidden} 篇</p> : null}
        </section>
      ))}
    </Dialog>
  );
}

/** userMetaTouched 时的补全论文信息确认：AI 不会静默覆盖手动修改过的字段。 */
export function ConfirmMetaDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const runPrepareMeta = useField((s) => s.runPrepareMeta);
  const { paper, missing } = useDialogPaper();
  const open = dialog === "confirm-meta" && Boolean(paper);
  useCloseWhenMissing(dialog === "confirm-meta", missing);

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
        你已经手动修改过论文信息，AI 不会静默覆盖。文献库查到的值优先，模型只补仍空的字段，
        也不会替换文献库的值。「保留我的修改」只补全空白字段；「用 AI 结果覆盖」会覆盖你修改过的字段。
      </p>
    </Dialog>
  );
}

export function EditPaperDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const savePaperPatch = useField((s) => s.savePaperPatch);
  const saveAuthors = useField((s) => s.saveAuthors);
  const setFlash = useField((s) => s.setFlash);
  // 打开时锁定的那篇：之后搜索或后台刷新改了选中，也只会保存到这篇。
  const { paper, missing } = useDialogPaper();
  const open = dialog === "edit-paper" && Boolean(paper);
  const [metaDirty, setMetaDirty] = useState(false);
  const [crewDirty, setCrewDirty] = useState(false);
  useCloseWhenMissing(dialog === "edit-paper", missing);

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
        // 「完成」与 Esc 走同一道未保存检查，不再静默丢弃修改。
        <Button type="button" onClick={() => (vetoClose() ? undefined : closeDialog())}>
          完成
        </Button>
      }
    >
      {paper ? (
        <>
          <MetaEditor
            key={paper.id}
            paper={paper}
            onDirtyChange={setMetaDirty}
            onSave={(patch) => savePaperPatch(paper.id, patch)}
          />
          <h3 className="ef-dialog-section">作者</h3>
          <CrewEditor
            key={`crew-${paper.id}`}
            authors={paper.authors}
            onDirtyChange={setCrewDirty}
            onSave={(next) => saveAuthors(paper.id, next)}
          />
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

type MetaDraft = ReturnType<typeof metaDraftOf>;
type MetaDraftKey = keyof MetaDraft;

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
  }) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState(() => metaDraftOf(paper));
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(new Set<MetaDraftKey>());
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const incoming = metaDraftOf(paper);
    setDraft((prev) => {
      const next = { ...incoming };
      for (const key of dirtyRef.current) next[key] = prev[key];
      return next;
    });
  }, [paper]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  function edit(key: MetaDraftKey, value: string) {
    dirtyRef.current.add(key);
    setDirty(true);
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  // 年份校验：非空时必须是可解析的整数（此前 Number("abc") → NaN 会把年份写成 NaN）。
  const yearText = draft.year.trim();
  const parsedYear = yearText ? Number.parseInt(yearText, 10) : null;
  const yearInvalid = Boolean(yearText) && (parsedYear === null || !Number.isFinite(parsedYear));

  return (
    <div>
      <Field label="英文标题">
        <input value={draft.title} onChange={(e) => edit("title", e.target.value)} />
      </Field>
      <Field label="中文标题">
        <input value={draft.titleZh} onChange={(e) => edit("titleZh", e.target.value)} />
      </Field>
      <Field label="摘要">
        <textarea value={draft.abstract} onChange={(e) => edit("abstract", e.target.value)} />
      </Field>
      <Field label="年份">
        <input
          value={draft.year}
          onChange={(e) => edit("year", e.target.value)}
          inputMode="numeric"
          aria-invalid={yearInvalid || undefined}
        />
      </Field>
      {yearInvalid ? (
        <p className="ef-error ef-field-error">
          年份需为数字，例如 2024。当前输入不会被保存。
        </p>
      ) : null}
      <Field label="会议 / 期刊">
        <input value={draft.venue} onChange={(e) => edit("venue", e.target.value)} />
      </Field>
      <Field label="DOI">
        <input value={draft.doi} onChange={(e) => edit("doi", e.target.value)} />
      </Field>
      <Field label="arXiv">
        <input value={draft.arxivId} onChange={(e) => edit("arxivId", e.target.value)} />
      </Field>
      <Field label="本地 PDF">
        <input value={paper.pdfPath ?? "尚未关联本地 PDF"} readOnly />
      </Field>
      <Field label="公开 PDF 链接">
        <input value={draft.pdfUrl} onChange={(e) => edit("pdfUrl", e.target.value)} />
      </Field>
      <Field label="代码仓库">
        <input value={draft.codeUrl} onChange={(e) => edit("codeUrl", e.target.value)} />
      </Field>
      <Field label="项目主页">
        <input value={draft.projectPage} onChange={(e) => edit("projectPage", e.target.value)} />
      </Field>
      <Field label="标签">
        <input value={draft.tags} onChange={(e) => edit("tags", e.target.value)} />
      </Field>
      <Button
        variant="primary"
        type="button"
        disabled={yearInvalid || saving}
        onClick={async () => {
          if (dirtyRef.current.size === 0) return;
          const dirtyFields = dirtyRef.current;
          const patch: Parameters<typeof onSave>[0] = {};
          if (dirtyFields.has("title")) patch.title = draft.title;
          if (dirtyFields.has("titleZh")) patch.titleZh = draft.titleZh || null;
          if (dirtyFields.has("abstract")) patch.abstract = draft.abstract;
          if (dirtyFields.has("year")) {
            patch.year = yearText && parsedYear !== null && Number.isFinite(parsedYear) ? parsedYear : null;
          }
          if (dirtyFields.has("venue")) patch.venue = draft.venue || null;
          if (dirtyFields.has("doi")) patch.doi = draft.doi || null;
          if (dirtyFields.has("arxivId")) patch.arxivId = draft.arxivId || null;
          if (dirtyFields.has("pdfUrl")) patch.pdfUrl = draft.pdfUrl || null;
          if (dirtyFields.has("codeUrl")) patch.codeUrl = draft.codeUrl || null;
          if (dirtyFields.has("projectPage")) patch.projectPage = draft.projectPage || null;
          if (dirtyFields.has("tags")) {
            patch.tags = draft.tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean);
          }
          setSaving(true);
          try {
            await onSave(patch);
            // 保存成功才清掉 dirty：之后 Esc / 完成不再误报「尚未保存」。
            dirtyRef.current.clear();
            setDirty(false);
          } catch {
            // 失败时保留输入与 dirty，store 已经给出错误通知。
          } finally {
            setSaving(false);
          }
        }}
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
  onSave: (authors: Author[]) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState(authors);
  const [editing, setEditing] = useState(false);
  const authorsDirtyRef = useRef(false);
  const [authorsDirty, setAuthorsDirty] = useState(false);

  useEffect(() => {
    if (authorsDirtyRef.current) return;
    setDraft(authors);
    setEditing(false);
  }, [authors]);

  useEffect(() => {
    onDirtyChange?.(authorsDirty);
  }, [authorsDirty, onDirtyChange]);

  function editAuthors(next: Author[]) {
    authorsDirtyRef.current = true;
    setAuthorsDirty(true);
    setDraft(next);
  }

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
                editAuthors(next);
              }}
            />
          </Field>
          <Field label="机构">
            <input
              value={author.affiliation ?? ""}
              onChange={(e) => {
                const next = [...draft];
                next[index] = { ...author, affiliation: e.target.value };
                editAuthors(next);
              }}
            />
          </Field>
          <Field label="实验室">
            <input
              value={author.lab ?? ""}
              onChange={(e) => {
                const next = [...draft];
                next[index] = { ...author, lab: e.target.value };
                editAuthors(next);
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
                editAuthors(next);
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
            editAuthors([
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
        <Button
          variant="primary"
          type="button"
          onClick={async () => {
            if (!authorsDirtyRef.current) return;
            try {
              await onSave(draft.filter((a) => a.name.trim()));
              authorsDirtyRef.current = false;
              setAuthorsDirty(false);
            } catch {
              // 失败时保留编辑中的作者。
            }
          }}
        >
          保存作者
        </Button>
      </div>
    </div>
  );
}
