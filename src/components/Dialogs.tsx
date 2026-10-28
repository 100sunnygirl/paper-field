import { useEffect, useRef, useState, type CSSProperties } from "react";
import { splitAuthorList } from "../lib/authorList";
import { pickPdfFiles, pickPdfFolder } from "../lib/mineru";
import { repo } from "../lib/repo";
import type { Author, PaperDetail } from "../lib/types";
import { isTauri } from "../lib/util";
import { useField } from "../store";
import { Button, Dialog, Field, Icon } from "./ui";

export function PaperDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const importPdfs = useField((s) => s.importPdfs);
  const [items, setItems] = useState<Array<{ path: string; name: string; duplicate: boolean; excluded: boolean }>>([]);
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
        <p>将删除「{current?.name}」及其中全部论文与笔记。删除后 10 秒内可「撤销删除」，超时后不可恢复。</p>
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

/** 移动后去向的本机偏好（跟随到目标领域 / 留在原领域）；存不进时按会话内选择走。 */
const MOVE_FOLLOW_KEY = "paper-field.move-follow";

function loadMoveFollow(): boolean {
  try {
    return (typeof localStorage !== "undefined" ? localStorage.getItem(MOVE_FOLLOW_KEY) : null) !== "stay";
  } catch {
    return true;
  }
}

function saveMoveFollow(follow: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(MOVE_FOLLOW_KEY, follow ? "follow" : "stay");
  } catch {
    // 偏好存不进不影响本次移动：对话框内仍按当前选择执行。
  }
}

export function DomainPickerDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const domains = useField((s) => s.domains);
  const selectedDomainId = useField((s) => s.selectedDomainId);
  const selectDomain = useField((s) => s.selectDomain);
  const movePaper = useField((s) => s.movePaper);
  const openDialog = useField((s) => s.openDialog);
  const dialogPaperId = useField((s) => s.dialogPaperId);
  const moving = dialog === "move-paper";
  const open = dialog === "pick-domain" || moving;
  // 去向选择：移动后「跟随到目标领域」（默认）或「留在当前领域」，本机记住偏好。
  const [follow, setFollow] = useState(() => loadMoveFollow());

  useEffect(() => {
    if (open) setFollow(loadMoveFollow());
  }, [open]);

  function chooseFollow(next: boolean) {
    setFollow(next);
    saveMoveFollow(next);
  }

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
      {moving ? (
        <div className="ef-move-follow" role="group" aria-label="移动后的去向">
          <span className="ef-move-follow-label">移动后</span>
          <Button
            type="button"
            size="sm"
            variant="text"
            className={follow ? "is-active" : ""}
            aria-pressed={follow}
            title="移动完成后直接进入目标领域，打开这篇论文"
            onClick={() => chooseFollow(true)}
          >
            跟随到目标领域
          </Button>
          <Button
            type="button"
            size="sm"
            variant="text"
            className={!follow ? "is-active" : ""}
            aria-pressed={!follow}
            title="移动完成后留在当前领域继续阅读原列表"
            onClick={() => chooseFollow(false)}
          >
            留在当前领域
          </Button>
        </div>
      ) : null}
      {domains.map((domain) => (
        <button
          key={domain.id}
          type="button"
          className={`ef-domain-option ${domain.id === selectedDomainId ? "is-current" : ""}`}
          onClick={() => {
            if (moving) void movePaper(domain.id, dialogPaperId ?? undefined, { follow });
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
      <p>将删除这篇论文及其全部笔记。删除后 10 秒内可「撤销删除」，超时后不可恢复。</p>
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
        将删除选中的 <strong>{checkedPaperIds.length}</strong> 篇论文及其全部笔记。删除后 10 秒内可「撤销删除」，超时后不可恢复。
      </p>
    </Dialog>
  );
}

export function ConfirmNotesDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const pendingDraftJob = useField((s) => s.pendingDraftJob);
  const runDraftNotes = useField((s) => s.runDraftNotes);
  const [busy, setBusy] = useState(false);

  async function overwrite() {
    if (busy) return;
    setBusy(true);
    try {
      await runDraftNotes(pendingDraftJob ?? undefined, true);
    } finally {
      setBusy(false);
    }
  }

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
          <Button variant="primary" type="button" disabled={busy} onClick={() => void overwrite()}>
            用 AI 草稿覆盖
          </Button>
        </>
      }
    >
      <p>你已经修改过笔记，AI 不会静默覆盖。确认后五个笔记板块都会替换为 AI 草稿；起草期间你再改的块会保留你的内容。</p>
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
  // 「保存全部并关闭」调用子编辑器保存函数的句柄（子组件挂载时注册）。
  const metaSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const crewSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const [savingAll, setSavingAll] = useState(false);
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

  /**
   * 「保存全部并关闭」：一次提交著录与作者两处修改，全部成功才关闭。
   * 著录先存——年份等校验失败时定位到未通过的字段（不保存、不关闭、作者也不动）；
   * 任一处保存失败（store 已提示）都留在对话框里，已成功的部分不再重复提交。
   */
  async function saveAllAndClose() {
    if (savingAll) return;
    setSavingAll(true);
    try {
      const metaOk = (await metaSaveRef.current?.()) ?? true;
      if (!metaOk) return;
      const crewOk = (await crewSaveRef.current?.()) ?? true;
      if (!crewOk) return;
      closeDialog();
    } finally {
      setSavingAll(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="编辑论文信息"
      onClose={closeDialog}
      vetoClose={vetoClose}
      className="is-wide"
      footer={
        <>
          {/* 「完成」与 Esc 走同一道未保存检查，不再静默丢弃修改。 */}
          <Button type="button" onClick={() => (vetoClose() ? undefined : closeDialog())}>
            完成
          </Button>
          <Button variant="primary" type="button" disabled={savingAll} onClick={() => void saveAllAndClose()}>
            {savingAll ? "保存中…" : "保存全部并关闭"}
          </Button>
        </>
      }
    >
      {paper ? (
        <>
          <MetaEditor
            key={paper.id}
            paper={paper}
            onDirtyChange={setMetaDirty}
            saveRef={metaSaveRef}
            onSave={(patch) => savePaperPatch(paper.id, patch)}
          />
          <h3 className="ef-dialog-section">作者</h3>
          <CrewEditor
            key={`crew-${paper.id}`}
            authors={paper.authors}
            onDirtyChange={setCrewDirty}
            saveRef={crewSaveRef}
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
  saveRef,
}: {
  paper: PaperDetail;
  onDirtyChange?: (dirty: boolean) => void;
  /** 父级「保存全部并关闭」的句柄：挂载期间始终指向最新的 save 实现。 */
  saveRef?: React.MutableRefObject<(() => Promise<boolean>) | null>;
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
  const yearInputRef = useRef<HTMLInputElement>(null);

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

  // 每次渲染都刷新句柄：「保存全部并关闭」拿到的总是最新草稿的保存实现。
  useEffect(() => {
    if (saveRef) saveRef.current = save;
  });

  function edit(key: MetaDraftKey, value: string) {
    dirtyRef.current.add(key);
    setDirty(true);
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  // 年份校验：非空时必须是可解析的整数（此前 Number("abc") → NaN 会把年份写成 NaN）。
  const yearText = draft.year.trim();
  const parsedYear = yearText ? Number.parseInt(yearText, 10) : null;
  const yearInvalid = Boolean(yearText) && (parsedYear === null || !Number.isFinite(parsedYear));

  /** 保存著录修改：true = 已保存（或本就无修改）；false = 校验失败 / 落库失败（store 已提示）。 */
  async function save(): Promise<boolean> {
    if (dirtyRef.current.size === 0) return true;
    if (yearInvalid) {
      // 定位到未通过的字段：焦点移到年份输入，行内错误已在下方展示。
      yearInputRef.current?.focus();
      return false;
    }
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
      return true;
    } catch {
      // 失败时保留输入与 dirty，store 已经给出错误通知。
      return false;
    } finally {
      setSaving(false);
    }
  }

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
          ref={yearInputRef}
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
        onClick={() => void save()}
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
  saveRef,
}: {
  authors: Author[];
  onDirtyChange?: (dirty: boolean) => void;
  /** 父级「保存全部并关闭」的句柄：挂载期间始终指向最新的 save 实现。 */
  saveRef?: React.MutableRefObject<(() => Promise<boolean>) | null>;
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

  useEffect(() => {
    if (saveRef) saveRef.current = save;
  });

  function editAuthors(next: Author[]) {
    authorsDirtyRef.current = true;
    setAuthorsDirty(true);
    setDraft(next);
  }

  // ---- 粘贴整段名单自动拆分（来自 PDF 的作者串）----
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);

  /** 拆分并替换整个作者列表（原文顺序即作者顺序），交由下方逐行控件校对。 */
  function applyPaste() {
    const names = splitAuthorList(pasteText);
    if (!names.length) {
      setPasteError("没有识别到作者姓名：支持换行、逗号、顿号或分号分隔，可带编号与（机构）括注。");
      return;
    }
    setPasteError(null);
    setPasteOpen(false);
    setPasteText("");
    editAuthors(
      names.map((name, order) => ({
        id: crypto.randomUUID(),
        name,
        nameZh: null,
        affiliation: "",
        lab: "",
        homepage: null,
        orcid: null,
        order,
        isCorresponding: false,
      })),
    );
  }

  /** 逐行校对控件：上移 / 下移 / 删除（拆分出的一长串名单靠它们整理）。 */
  function moveAuthor(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= draft.length) return;
    const next = [...draft];
    [next[index], next[target]] = [next[target], next[index]];
    editAuthors(next);
  }

  function removeAuthor(index: number) {
    editAuthors(draft.filter((_, i) => i !== index));
  }

  /** 保存作者修改：true = 已保存（或本就无修改）；false = 落库失败（store 已提示）。 */
  async function save(): Promise<boolean> {
    if (!authorsDirtyRef.current) return true;
    try {
      await onSave(draft.filter((a) => a.name.trim()));
      authorsDirtyRef.current = false;
      setAuthorsDirty(false);
      return true;
    } catch {
      // 失败时保留编辑中的作者。
      return false;
    }
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
      <div className="ef-crew-paste">
        {pasteOpen ? (
          <div className="ef-crew-paste-area">
            <textarea
              aria-label="粘贴作者名单"
              rows={4}
              value={pasteText}
              onChange={(e) => {
                setPasteText(e.target.value);
                setPasteError(null);
              }}
              placeholder={"支持换行、逗号、顿号、分号分隔，可含编号与（机构）括注\n例如：1. Alice Smith (MIT)、Bob Lee；Carol Wu"}
            />
            <div className="job-row">
              <Button type="button" size="sm" onClick={applyPaste}>
                拆分为作者行
              </Button>
              <Button
                type="button"
                size="sm"
                variant="text"
                onClick={() => {
                  setPasteOpen(false);
                  setPasteError(null);
                }}
              >
                取消
              </Button>
            </div>
            {pasteError ? <p className="ef-error">{pasteError}</p> : null}
            <p className="ef-crew-paste-hint">拆分会替换下方作者列表；含逗号的姓名（如 Smith, J.）拆分后请逐项校对。</p>
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="text"
            aria-expanded={pasteOpen}
            onClick={() => {
              setPasteOpen(true);
              setPasteError(null);
            }}
          >
            <Icon name="copy" />
            粘贴整段名单…
          </Button>
        )}
      </div>
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
          <span className="ef-crew-row-tools">
            <Button
              type="button"
              size="sm"
              variant="text"
              className="ef-icon-btn"
              aria-label={`上移作者 ${index + 1}`}
              title={`上移作者 ${index + 1}`}
              disabled={index === 0}
              onClick={() => moveAuthor(index, -1)}
            >
              <Icon name="up" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="text"
              className="ef-icon-btn"
              aria-label={`下移作者 ${index + 1}`}
              title={`下移作者 ${index + 1}`}
              disabled={index === draft.length - 1}
              onClick={() => moveAuthor(index, 1)}
            >
              <Icon name="down" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="text"
              className="ef-icon-btn"
              aria-label={`删除作者 ${index + 1}`}
              title={`删除作者 ${index + 1}`}
              onClick={() => removeAuthor(index)}
            >
              <Icon name="trash" />
            </Button>
          </span>
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
          onClick={() => void save()}
        >
          保存作者
        </Button>
      </div>
    </div>
  );
}
