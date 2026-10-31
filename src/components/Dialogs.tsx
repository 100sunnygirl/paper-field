import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { splitAuthorList } from "../lib/authorList";
import { DOMAIN_ACCENTS } from "../lib/domainExtras";
import { loadRecentDomains, orderDomainsByRecent } from "../lib/domainRecent";
import { looksLikeNonPaper, scanImportItem, type ImportItemScan, type PaperRef } from "../lib/importScan";
import { lookupPaper } from "../lib/lookup";
import { pickPdfFiles, pickPdfFolder } from "../lib/mineru";
import { providerLabel } from "../lib/mineruPlan";
import { parsePastedRef, type ParsedRef } from "../lib/pasteRef";
import { repo } from "../lib/repo";
import type { Author, DomainCensus, PaperDetail } from "../lib/types";
import { formatDate, isTauri } from "../lib/util";
import { useField, type ImportMode } from "../store";
import { ImportTarget } from "./ImportTarget";
import { Button, Dialog, Field, Icon } from "./ui";

/** 导入模式：导入即自动解析是默认流程，但不是每次收集都想立刻烧解析/补全额度。 */
const IMPORT_MODES: Array<{ value: ImportMode; label: string; hint: string }> = [
  { value: "library", label: "只入库", hint: "不提交解析；之后可在设置页「继续未完成的解析」" },
  { value: "parse", label: "入库并解析", hint: "解析完成不自动排队 AI 补全" },
  { value: "parse-meta", label: "解析后补全", hint: "既有默认流程：解析完成后自动补全元数据" },
];
const IMPORT_MODE_KEY = "paper-field.import-mode";

/** 秒级时长的小时：秒 →「45 秒」，分 →「1 分 23 秒」。 */
function formatSpanShort(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

/** 记住上次选择的导入模式（本机 localStorage）；认不出的旧值回落默认。 */
function readImportMode(): ImportMode {
  try {
    const raw = localStorage.getItem(IMPORT_MODE_KEY);
    const found = IMPORT_MODES.find((item) => item.value === raw);
    return found ? found.value : "parse-meta";
  } catch {
    return "parse-meta";
  }
}

function writeImportMode(mode: ImportMode): void {
  try {
    localStorage.setItem(IMPORT_MODE_KEY, mode);
  } catch {
    // 记不住就用本次会话的选择，不影响导入。
  }
}

/** 新建领域的示例模板：一键套用名称与简介，新人不用对着空白表单发呆。 */
const DOMAIN_TEMPLATES: Array<{ id: string; name: string; summary: string }> = [
  { id: "research", name: "研究方向", summary: "围绕一个长期研究方向收集论文（如：多模态对齐）。" },
  { id: "project", name: "在研项目", summary: "一个具体项目/系统用到的论文与参考资料。" },
  { id: "course", name: "课程 / 综述", summary: "课程阅读清单或某篇综述的延伸论文。" },
];

export function PaperDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const importPdfs = useField((s) => s.importPdfs);
  const importPdfsPerFile = useField((s) => s.importPdfsPerFile);
  const attachPdfToPaper = useField((s) => s.attachPdfToPaper);
  const selectDomain = useField((s) => s.selectDomain);
  const selectPaper = useField((s) => s.selectPaper);
  const domains = useField((s) => s.domains);
  // 导入目标：显式改选（含就地新建）优先，缺省跟随当前选中领域；对话框顶部常驻可见。
  const importTargetDomainId = useField((s) => s.importTargetDomainId);
  const selectedDomainId = useField((s) => s.selectedDomainId);
  const targetDomainId = importTargetDomainId ?? selectedDomainId;
  const targetDomain = domains.find((d) => d.id === targetDomainId) ?? null;
  // 清单里逐文件可指定目标领域（domainTouched：用户单独改过的不跟随对话框目标联动）。
  const [items, setItems] = useState<
    Array<{
      path: string;
      name: string;
      duplicate: boolean;
      excluded: boolean;
      domainId: string;
      domainTouched: boolean;
      /** 文件名扫描：提取的 arXiv 号 / 清洗标题 / 与库内著录的重复候选。 */
      scan: ImportItemScan | null;
      /** 「已在库中」对应的原条目（点开直达）。 */
      duplicatePaper: { id: string; title: string; domainName: string; domainId: string } | null;
      /** 已通过「补充到已有条目」挂上文件的行：不再参与导入。 */
      attached: boolean;
    }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  // 导入开始时刻：进度行据此显示「已用时间」与按均值的「预计剩余」（nowTick 仅驱动秒级重渲染）。
  const [importStartedAt, setImportStartedAt] = useState<number | null>(null);
  const [, setNowTick] = useState(0);
  const [manualOpen, setManualOpen] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);
  // 导入模式（只入库 / 入库并解析 / 解析后补全），记住上次选择。
  const [mode, setMode] = useState<ImportMode>(() => readImportMode());
  const effectiveProvider = useField((s) => s.effectiveProvider);
  const mineru = useField((s) => s.mineru);
  const open = dialog === "paper";

  useEffect(() => {
    if (!open) return;
    setItems([]);
    setError(null);
    setBusy(false);
    setProgress(null);
    setImportStartedAt(null);
    setManualOpen(false);
    setAttachBusy(false);
  }, [open]);

  // 导入进行中每秒走一格表：即使单文件耗时很长，「已用时间」也在动（结束即停）。
  useEffect(() => {
    if (!busy || !importStartedAt) return;
    const timer = setInterval(() => setNowTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [busy, importStartedAt]);

  // 对话框目标领域变化时：没被单独改过的行跟着换目标（跨领域收集时先全部指到 A 再逐个改）。
  useEffect(() => {
    if (!targetDomainId) return;
    setItems((current) =>
      current.some((item) => !item.domainTouched && item.domainId !== targetDomainId)
        ? current.map((item) => (item.domainTouched ? item : { ...item, domainId: targetDomainId }))
        : current,
    );
  }, [targetDomainId]);

  async function addPaths(paths: string[]) {
    const known = new Set(await repo.pdfPaths());
    // 库内轻量引用：既找出「已在库中」的原条目，也做 arXiv/标题的重复候选扫描。
    let refs: PaperRef[] = [];
    try {
      refs = await repo.paperRefsForDedup();
    } catch {
      refs = []; // 引用读不到时只保留按路径的重复标记，候选扫描安静降级。
    }
    const byPath = new Map<string, PaperRef>();
    for (const ref of refs) {
      if (ref.pdfPath) byPath.set(ref.pdfPath, ref);
      if (ref.pdfOriginalPath) byPath.set(ref.pdfOriginalPath, ref);
    }
    const fallbackDomain = targetDomainId ?? domains[0]?.id ?? "";
    setItems((current) => {
      const next = new Map(current.map((item) => [item.path, item]));
      for (const path of paths) {
        const name = path.split(/[/\\]/).pop() ?? path;
        // 重新扫描同一目录时保留用户已排除的选择与单独指定过的目标领域，不悄悄改回；
        // 新文件按文件名预判非论文 PDF（课件/习题/表单等强信号词）默认不勾选，允许改选。
        const prev = current.find((item) => item.path === path);
        const excluded = prev?.excluded ?? looksLikeNonPaper(name);
        const domainId = prev?.domainId ?? fallbackDomain;
        const domainTouched = prev?.domainTouched ?? false;
        const ref = byPath.get(path) ?? null;
        next.set(path, {
          path,
          name,
          duplicate: known.has(path),
          excluded,
          domainId,
          domainTouched,
          scan: prev?.scan ?? scanImportItem(name, refs),
          duplicatePaper: ref
            ? { id: ref.id, title: ref.titleZh || ref.title, domainName: ref.domainName, domainId: ref.domainId }
            : null,
          attached: prev?.attached ?? false,
        });
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

  const fresh = items.filter((item) => !item.duplicate && !item.excluded && !item.attached);
  const checkable = items.filter((item) => !item.duplicate && !item.attached);
  const checkedCount = checkable.filter((item) => !item.excluded).length;
  // 本批要分入几个领域：1 个保持「导入 N 篇到「X」」的原按钮与原链路；多个则走逐文件导入。
  const freshDomains = [...new Set(fresh.map((item) => item.domainId))];
  const multiDomain = freshDomains.length > 1;

  function toggleExcluded(path: string, excluded: boolean) {
    setItems((current) => current.map((item) => (item.path === path ? { ...item, excluded } : item)));
  }

  function setAllExcluded(excluded: boolean) {
    setItems((current) => current.map((item) => (item.duplicate || item.attached ? item : { ...item, excluded })));
  }

  function setItemDomain(path: string, domainId: string) {
    setItems((current) => current.map((item) => (item.path === path ? { ...item, domainId, domainTouched: true } : item)));
  }

  /** 「全部使用此领域」：整批改到同一领域（含被排除行，保持后续再勾选时语义一致）。 */
  function setAllDomain(domainId: string) {
    setItems((current) => current.map((item) => ({ ...item, domainId, domainTouched: false })));
  }

  function setGroupDomain(paths: string[], domainId: string) {
    const group = new Set(paths);
    setItems((current) => current.map((item) => (group.has(item.path) ? { ...item, domainId, domainTouched: true } : item)));
  }

  // 按文件夹分组（跨领域收集时按目录审阅；单一目录保持原平铺清单）。
  const groups = new Map<string, typeof items>();
  for (const item of items) {
    const dir = item.path.split(/[/\\]/).slice(0, -1).join("/") || "/";
    const list = groups.get(dir) ?? [];
    list.push(item);
    groups.set(dir, list);
  }
  const groupEntries = [...groups.entries()];
  const multiDir = groupEntries.length > 1;

  /** 组内目标领域一致时返回该领域，不一致返回 ""（下拉显示「选择领域」占位）。 */
  function groupDomainValue(groupItems: typeof items): string {
    const first = groupItems[0]?.domainId ?? "";
    return groupItems.every((item) => item.domainId === first) ? first : "";
  }

  /** 「补充到已有条目」：把这个 PDF 挂到候选的那篇论文上，行转为已补充，不再参与导入。 */
  async function attachCandidate(item: (typeof items)[number]) {
    if (!item.scan?.candidate || attachBusy) return;
    setAttachBusy(true);
    try {
      await attachPdfToPaper(item.scan.candidate.paperId, item.path);
      setItems((current) => current.map((row) => (row.path === item.path ? { ...row, attached: true } : row)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttachBusy(false);
    }
  }

  /** 「已在库中」顺路直达原条目：关掉导入对话框、切到所属领域并打开那篇论文。 */
  function openDuplicatePaper(duplicate: NonNullable<(typeof items)[number]["duplicatePaper"]>) {
    closeDialog();
    void selectDomain(duplicate.domainId)
      .then(() => selectPaper(duplicate.id))
      .catch(() => {
        // 直达不是关键路径：失败已有提示，导入清单本身不受影响。
      });
  }

  function renderItem(item: (typeof items)[number], index: number) {
    const candidate = item.scan?.candidate ?? null;
    return (
      <li
        key={item.path}
        className={`pf-stagger${item.excluded && !item.duplicate ? " is-excluded" : ""}`}
        style={{ "--pf-i": index } as CSSProperties}
      >
        <label className="ef-import-check">
          <input
            type="checkbox"
            checked={!item.duplicate && !item.excluded && !item.attached}
            disabled={busy || item.duplicate || item.attached}
            onChange={(e) => toggleExcluded(item.path, !e.target.checked)}
          />
          <span>{item.name}</span>
        </label>
        <span className="ef-import-row-side">
          {domains.length > 1 && !item.duplicate && !item.attached ? (
            <select
              className="ef-import-row-domain"
              aria-label={`目标领域：${item.name}`}
              value={item.domainId}
              disabled={busy}
              onChange={(e) => setItemDomain(item.path, e.target.value)}
            >
              {domains.map((domain) => (
                <option key={domain.id} value={domain.id}>
                  {domain.name}
                </option>
              ))}
            </select>
          ) : null}
          {item.attached ? (
            <em>已补充到「{candidate?.title ?? "已有条目"}」</em>
          ) : item.duplicate ? (
            item.duplicatePaper ? (
              <button
                type="button"
                className="ef-import-dup-link"
                title={`打开库里那篇：「${item.duplicatePaper.title}」（${item.duplicatePaper.domainName}）`}
                onClick={() => openDuplicatePaper(item.duplicatePaper!)}
              >
                已在库中 · {item.duplicatePaper.title}（{item.duplicatePaper.domainName}）
              </button>
            ) : (
              <em>已在库中</em>
            )
          ) : candidate ? (
            <span className="ef-import-dup">
              <span className="ef-import-dup-info">
                疑似已有 · {candidate.title}（{candidate.domainName}）· {candidate.detail}
              </span>
              <Button
                type="button"
                size="sm"
                variant="text"
                disabled={busy || attachBusy}
                title={`把这个 PDF 补充到「${candidate.title}」，不另建新条目`}
                onClick={() => void attachCandidate(item)}
              >
                补充到已有条目
              </Button>
            </span>
          ) : null}
        </span>
      </li>
    );
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
                setImportStartedAt(Date.now());
                const onProgress = (done: number, total: number, current: string) =>
                  setProgress({ done, total, current });
                // 单一目标领域：走原有 importPdfs 链路；逐文件多领域：走 importPdfsPerFile。
                // 两种链路都带上导入模式（只入库 / 入库并解析 / 解析后补全）。
                const run = multiDomain
                  ? importPdfsPerFile(
                      fresh.map((item) => ({ path: item.path, domainId: item.domainId })),
                      onProgress,
                      { mode },
                    )
                  : importPdfs(fresh.map((item) => item.path), onProgress, fresh[0]?.domainId || undefined, { mode });
                void run
                  .catch((err: unknown) => {
                    setError(err instanceof Error ? err.message : String(err));
                  })
                  .finally(() => {
                    setBusy(false);
                    setProgress(null);
                  });
              }}
            >
              {busy
                ? "导入中…"
                : multiDomain
                  ? `导入 ${fresh.length} 篇 · 分入 ${freshDomains.length} 个领域`
                  : targetDomain
                    ? `导入 ${fresh.length} 篇到「${targetDomain.name}」`
                    : `导入 ${fresh.length}`}
            </Button>
          ) : null}
        </>
      }
    >
      <p>
        选择本机 PDF，或一个目录中的全部 PDF（只读所选目录本身，不进入子目录）。加入后先在下方清单里勾选，排除不是论文的
        PDF，再完成导入。文件名会先当作标题，导入后立即交给 MinerU 解析。没有 PDF 时也可手动添加论文。
      </p>
      {/* 目标领域常驻可见可改：从 INTAKE 发起导入也能看清要导入哪、就地下拉更换或新建。 */}
      <ImportTarget />
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
              {importStartedAt ? ` · 已用 ${formatSpanShort(Date.now() - importStartedAt)}` : ""}
              {/* 预计剩余按已完成各篇的均值估算；第一篇没跑完时不猜（诚实显示）。 */}
              {importStartedAt && progress.done > 0 && progress.done < progress.total
                ? ` · 预计剩余 ${formatSpanShort(((Date.now() - importStartedAt) / progress.done) * (progress.total - progress.done))}`
                : ""}
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
              {domains.length > 1 ? (
                <label className="ef-import-bulk-domain">
                  全部使用
                  <select
                    aria-label="全部使用此领域"
                    value={freshDomains.length === 1 ? freshDomains[0] : ""}
                    disabled={busy}
                    onChange={(e) => setAllDomain(e.target.value)}
                  >
                    <option value="" disabled>
                      选择领域
                    </option>
                    {domains.map((domain) => (
                      <option key={domain.id} value={domain.id}>
                        {domain.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
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
          {isTauri() ? (
            <div className="ef-import-mode" role="group" aria-label="导入模式">
              {IMPORT_MODES.map((item) => (
                <Button
                  key={item.value}
                  type="button"
                  size="sm"
                  className={mode === item.value ? "is-active" : ""}
                  aria-pressed={mode === item.value}
                  title={item.hint}
                  disabled={busy}
                  onClick={() => {
                    setMode(item.value);
                    writeImportMode(item.value);
                  }}
                >
                  {item.label}
                </Button>
              ))}
              <span className="ef-import-mode-source">
                {effectiveProvider
                  ? `本批解析源：${providerLabel(effectiveProvider)}`
                  : mineru.configured
                    ? "解析源当前探测未通过，可选「只入库」稍后再解析"
                    : "尚未配置解析源，可选「只入库」稍后再解析"}
              </span>
            </div>
          ) : null}
          <ul className="ef-import-list">
            {multiDir
              ? groupEntries.map(([dir, groupItems]) => (
                  <Fragment key={dir}>
                    <li className="ef-import-group">
                      <span className="ef-import-group-dir mono" title={dir}>
                        {dir.split(/[/\\]/).filter(Boolean).slice(-1)[0] || dir}
                      </span>
                      <label className="ef-import-bulk-domain">
                        此文件夹全部
                        <select
                          aria-label={`此文件夹全部使用：${dir}`}
                          value={groupDomainValue(groupItems)}
                          disabled={busy}
                          onChange={(e) => setGroupDomain(groupItems.map((item) => item.path), e.target.value)}
                        >
                          {groupDomainValue(groupItems) === "" ? (
                            <option value="" disabled>
                              选择领域
                            </option>
                          ) : null}
                          {domains.map((domain) => (
                            <option key={domain.id} value={domain.id}>
                              {domain.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </li>
                    {groupItems.map((item) => renderItem(item, items.indexOf(item)))}
                  </Fragment>
                ))
              : items.map((item, index) => renderItem(item, index))}
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
  // 粘贴识别：一段文本自动拆出 arXiv / DOI / BibTeX 字段；失焦查文献库回显「已找到」。
  const [pasted, setPasted] = useState("");
  const [parsed, setParsed] = useState<ParsedRef | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [found, setFound] = useState<{ title: string; year: number | null } | null>(null);
  const [lookupMissed, setLookupMissed] = useState(false);
  const lastLookupKey = useRef<string | null>(null);

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

  /** 粘贴内容变化即识别并拆字段（只覆盖仍为空的字段，不冲掉手填内容）。 */
  function applyPasted(text: string) {
    setPasted(text);
    setFound(null);
    setLookupMissed(false);
    const ref = parsePastedRef(text);
    setParsed(ref);
    if (!ref) return;
    if (ref.arxivId && !arxivId.trim()) setArxivId(ref.arxivId);
    if (ref.doi && !doi.trim()) setDoi(ref.doi);
    if (ref.title && !title.trim()) setTitle(ref.title);
  }

  /** 失焦回显：有标识符时查一次文献库，找到就显示「已找到：标题（年份）」。 */
  async function lookupOnBlur() {
    const key = [parsed?.arxivId ?? "", parsed?.doi ?? "", parsed?.title ?? ""].join("|");
    if (!parsed || (!parsed.arxivId && !parsed.doi) || key === lastLookupKey.current) return;
    lastLookupKey.current = key;
    setLookupBusy(true);
    setFound(null);
    setLookupMissed(false);
    try {
      // 只用标识符查（不拿半截标题当键）；浏览器预览查不到，同样给出诚实提示。
      const result = await lookupPaper({
        title: "",
        arxivId: parsed.arxivId ?? null,
        doi: parsed.doi ?? null,
        year: null,
        authors: [],
      });
      if (result.meta?.title) setFound({ title: result.meta.title, year: result.meta.year ?? null });
      else setLookupMissed(true);
    } finally {
      setLookupBusy(false);
    }
  }

  const titleMissing = Boolean(busy === false && error && !title.trim());

  return (
    <div className="ef-manual-paper pf-enter">
      <Field label="粘贴链接 / 标识符 / BibTeX（自动识别）">
        <textarea
          value={pasted}
          onChange={(e) => applyPasted(e.target.value)}
          onBlur={() => void lookupOnBlur()}
          placeholder="粘贴 arXiv 链接、DOI、doi.org/arXiv.org 地址或整段 BibTeX，自动拆到下方字段"
          className="ef-paste-box"
          aria-describedby={parsed ? "ef-paste-recognized" : undefined}
        />
      </Field>
      {parsed ? (
        <p className="ef-paste-recognized" id="ef-paste-recognized">
          已识别：
          {parsed.kind === "bibtex"
            ? `BibTeX${parsed.title ? `「${parsed.title}」` : ""}${parsed.venue ? ` · ${parsed.venue}` : ""}`
            : parsed.kind === "arxiv"
              ? `arXiv ${parsed.arxivId}`
              : `DOI ${parsed.doi}`}
          {parsed.kind !== "bibtex" ? "，已填入下方字段；失焦可先查一次著录。" : "，已填入下方字段。"}
        </p>
      ) : pasted.trim() ? (
        <p className="ef-paste-recognized is-miss">未识别出 arXiv / DOI / BibTeX，可直接在下方手填。</p>
      ) : null}
      {lookupBusy ? <p className="ef-paste-recognized">正在查询文献库…</p> : null}
      {found ? (
        <p className="ef-paste-recognized is-hit">
          已找到：{found.title}
          {found.year ? `（${found.year}）` : ""}
          {found.title !== title ? (
            <>
              {" "}
              <Button
                type="button"
                size="sm"
                variant="text"
                onClick={() => {
                  setTitle(found.title);
                  setPasted("");
                  setParsed(null);
                }}
              >
                用这个标题
              </Button>
            </>
          ) : null}
        </p>
      ) : lookupMissed ? (
        <p className="ef-paste-recognized">文献库这次没查到；创建论文后仍会自动查询并补全著录。</p>
      ) : null}
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
  const migrateDomainThenDelete = useField((s) => s.migrateDomainThenDelete);
  const exportPapers = useField((s) => s.exportPapers);
  const domains = useField((s) => s.domains);
  const selectedDomainId = useField((s) => s.selectedDomainId);
  const current = domains.find((d) => d.id === selectedDomainId);
  const editing = dialog === "edit-domain";
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [summary, setSummary] = useState("");
  const [keyQuestion, setKeyQuestion] = useState("");
  const [accent, setAccent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 删除确认升级：损失清单（论文/笔记数）+ 先导出 + 迁移后删除三选一。
  const [deletionStats, setDeletionStats] = useState<{ papers: number; notes: number; read: number } | null>(null);
  const [migrateMode, setMigrateMode] = useState(false);
  const [migrateTarget, setMigrateTarget] = useState("");
  const open = dialog === "domain" || dialog === "edit-domain";

  useEffect(() => {
    if (!open) return;
    if (editing && current) {
      setName(current.name);
      setCode(current.code);
      setSummary(current.summary ?? "");
      setKeyQuestion(current.keyQuestion ?? "");
      setAccent(current.accent ?? null);
    } else if (!editing) {
      setName("");
      setCode("");
      setSummary("");
      setKeyQuestion("");
      setAccent(null);
    }
    setError(null);
    setConfirmDelete(false);
    setMigrateMode(false);
    setMigrateTarget("");
  }, [open, editing, selectedDomainId]);

  useEffect(() => {
    // 进入确认步时读一次损失清单（当前领域）；读不到则降级为笼统警告。
    if (!(open && confirmDelete && editing && current)) {
      setDeletionStats(null);
      return;
    }
    let alive = true;
    repo
      .domainDeletionStats(current.id)
      .then((stats) => {
        if (alive) setDeletionStats(stats);
      })
      .catch(() => {
        if (alive) setDeletionStats(null);
      });
    return () => {
      alive = false;
    };
  }, [open, confirmDelete, editing, current]);

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
            {migrateMode ? (
              <Button
                type="button"
                variant="primary"
                disabled={!migrateTarget}
                onClick={() => void migrateDomainThenDelete(migrateTarget)}
              >
                迁移并删除领域
              </Button>
            ) : (
              <Button type="button" className="ef-btn-danger-solid" onClick={() => void deleteDomain()}>
                确认删除领域
              </Button>
            )}
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
                  ? updateDomain({ name, code, summary, keyQuestion, accent })
                  : createDomain({ name, code, summary, keyQuestion, accent });
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
        <div className="ef-domain-delete-review">
          {deletionStats ? (
            <p>
              将删除「{current?.name}」里的 <strong>{deletionStats.papers}</strong> 篇论文（已读{" "}
              {deletionStats.read} 篇）与 <strong>{deletionStats.notes}</strong> 条笔记。删除后 10
              秒内可「撤销删除」；整域快照也会进回收站保留 30 天。
            </p>
          ) : (
            <p>将删除「{current?.name}」及其中全部论文与笔记。删除后 10 秒内可「撤销删除」，超时后不可恢复。</p>
          )}
          {!migrateMode ? (
            <div className="ef-domain-delete-actions">
              <Button
                type="button"
                size="sm"
                disabled={!deletionStats?.papers}
                title={deletionStats?.papers ? "把当前领域的论文导出为 Markdown（删除前留一份）" : "这个领域没有论文可导出"}
                onClick={() => void exportPapers({ scope: "current", format: "folders", include: { notes: true, abstract: true, parsedText: false } })}
              >
                先导出为 Markdown 再删除
              </Button>
              <Button type="button" size="sm" disabled={(domains.length ?? 0) < 2} onClick={() => setMigrateMode(true)}>
                迁移到其他领域后删除…
              </Button>
            </div>
          ) : (
            <div className="ef-domain-delete-migrate">
              <Field label="迁入领域">
                <select value={migrateTarget} onChange={(e) => setMigrateTarget(e.target.value)}>
                  <option value="">选择要迁入的领域…</option>
                  {domains
                    .filter((domain) => domain.id !== current?.id)
                    .map((domain) => (
                      <option key={domain.id} value={domain.id}>
                        {domain.name}（{domain.code}）
                      </option>
                    ))}
                </select>
              </Field>
              <p className="ef-field-hint">论文与笔记将完整移入目标领域，然后删除这个空领域。</p>
            </div>
          )}
        </div>
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
          {!editing ? (
            <div className="ef-domain-templates" role="group" aria-label="示例模板">
              <span className="ef-domain-templates-label">示例模板，一键套用：</span>
              {DOMAIN_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  title={template.summary}
                  onClick={() => {
                    setName(template.name);
                    setSummary(template.summary);
                  }}
                >
                  {template.name}
                </button>
              ))}
            </div>
          ) : null}
          <Field label="短码（可选）">
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="留空自动生成，如 MM-03" />
          </Field>
          <Field label="简介（可选）">
            <textarea value={summary} onChange={(e) => setSummary(e.target.value)} />
          </Field>
          <Field label="关键问题（可选）">
            <input
              value={keyQuestion}
              onChange={(e) => setKeyQuestion(e.target.value)}
              placeholder="这个领域最想回答的一个问题"
            />
            <small className="ef-field-hint">进入领域时会显示为一句提示，提醒自己为什么读这些论文。</small>
          </Field>
          <div className="ef-field">
            <span>强调色（可选）</span>
            <div className="ef-domain-swatches" role="radiogroup" aria-label="领域强调色">
              <button
                type="button"
                role="radio"
                aria-checked={accent === null}
                aria-label="默认"
                className={accent === null ? "is-on" : ""}
                onClick={() => setAccent(null)}
              >
                默认
              </button>
              {DOMAIN_ACCENTS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={accent === item.id}
                  aria-label={item.label}
                  title={item.label}
                  className={accent === item.id ? "is-on" : ""}
                  style={{ background: `var(--pf-accent-${item.id})` }}
                  onClick={() => setAccent(item.id)}
                />
              ))}
            </div>
            <small className="ef-field-hint">领域头进度条与领域条会用这个颜色归组；不选则用默认墨色。</small>
          </div>
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
  const moveCheckedPapers = useField((s) => s.moveCheckedPapers);
  const openDialog = useField((s) => s.openDialog);
  const dialogPaperId = useField((s) => s.dialogPaperId);
  const dialogPaperIds = useField((s) => s.dialogPaperIds);
  const moving = dialog === "move-paper";
  // 批量移动：勾选集在对话框打开时冻结（dialogPaperIds），确认期间不被后台刷新改动。
  const movingChecked = dialog === "move-checked";
  const open = dialog === "pick-domain" || moving || movingChecked;
  // 去向选择：移动后「跟随到目标领域」（默认）或「留在当前领域」，本机记住偏好。
  const [follow, setFollow] = useState(() => loadMoveFollow());

  useEffect(() => {
    if (open) setFollow(loadMoveFollow());
  }, [open]);

  function chooseFollow(next: boolean) {
    setFollow(next);
    saveMoveFollow(next);
  }

  // 搜索过滤 + 最近使用置顶 + ↑↓/Enter 键盘选择：领域多时不必线性滚动逐个找。
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  // 移动模式：就地新建领域并移入（目标领域不存在时不必中途退出先去建）。
  const createDomainAndMove = useField((s) => s.createDomainAndMove);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createInputRef = useRef<HTMLInputElement | null>(null);
  // 手动排序模式：按 sort_order 列出并 ↑↓ 调整，改动即时写回（常用领域可以靠前）。
  const applyDomainOrder = useField((s) => s.applyDomainOrder);
  const [ordering, setOrdering] = useState(false);
  const [order, setOrder] = useState<string[]>([]);
  // 每行右侧的论文数 / 已读进度 / 最近阅读：一次聚合查询，读不到时行内降级隐藏。
  const [census, setCensus] = useState<Record<string, DomainCensus> | null>(null);

  useEffect(() => {
    if (!open || ordering) return;
    let alive = true;
    repo
      .domainCensus()
      .then((rows) => {
        if (alive) setCensus(Object.fromEntries(rows.map((row) => [row.domainId, row])));
      })
      .catch(() => {
        if (alive) setCensus(null);
      });
    return () => {
      alive = false;
    };
  }, [open, ordering]);

  useEffect(() => {
    if (!open) {
      setCreating(false);
      setNewName("");
      setCreateBusy(false);
      setCreateError(null);
      setOrdering(false);
      setOrder([]);
      return;
    }
    setQuery("");
    setActiveIndex(0);
    setRecent(loadRecentDomains());
  }, [open]);

  const ordered = useMemo(() => orderDomainsByRecent(domains, recent), [domains, recent]);
  const keyword = query.trim().toLowerCase();
  const filtered = keyword
    ? ordered.filter(
        (domain) =>
          domain.name.toLowerCase().includes(keyword) || domain.code.toLowerCase().includes(keyword),
      )
    : ordered;
  const recentSet = useMemo(() => new Set(recent), [recent]);

  useEffect(() => {
    setActiveIndex(0);
  }, [keyword]);

  useEffect(() => {
    // 键盘高亮行保持在可视区内（jsdom 无 scrollIntoView，可选调用静默跳过）。
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    if (creating) createInputRef.current?.focus();
  }, [creating]);

  function pick(domainId: string) {
    if (movingChecked) void moveCheckedPapers(domainId);
    else if (moving) void movePaper(domainId, dialogPaperId ?? undefined, { follow });
    else void selectDomain(domainId);
  }

  function startCreate(initial: string) {
    setNewName(initial);
    setCreateError(null);
    setCreating(true);
  }

  async function submitCreate() {
    if (!moving || createBusy) return;
    const name = newName.trim();
    if (!name) {
      setCreateError("请先输入新领域的名称。");
      return;
    }
    setCreateError(null);
    setCreateBusy(true);
    try {
      // 成功后 movePaper 会关掉对话框；失败保留输入与就地展开的状态。
      await createDomainAndMove(name, dialogPaperId ?? undefined);
    } catch (err) {
      setCreateBusy(false);
      setCreateError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleOrdering() {
    if (!ordering) setOrder(domains.map((domain) => domain.id));
    setOrdering((value) => !value);
  }

  function moveOrder(id: string, dir: -1 | 1) {
    const index = order.indexOf(id);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
    // 每次调整即时写回 sort_order：中途关掉对话框顺序也已生效。
    void applyDomainOrder(next);
  }

  function onFilterKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      if (filtered.length) {
        event.preventDefault();
        pick(filtered[activeIndex].id);
      } else if (moving && keyword) {
        // 搜索无匹配：Enter 直接把搜索词带进「新建领域并移入」，再按一次 Enter 完成。
        event.preventDefault();
        startCreate(query.trim());
      }
      return;
    }
    if (!filtered.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % filtered.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + filtered.length) % filtered.length);
    }
  }

  return (
    <Dialog
      open={open}
      title={moving ? "移动到其他领域" : movingChecked ? "移动选中论文到其他领域" : "切换研究领域"}
      onClose={closeDialog}
      footer={
        moving || movingChecked ? (
          <Button type="button" onClick={closeDialog}>
            取消
          </Button>
        ) : (
          <>
            {!ordering ? (
              <Button type="button" onClick={() => openDialog("merge-domain")}>
                合并领域…
              </Button>
            ) : null}
            <Button
              type="button"
              aria-pressed={ordering}
              className={ordering ? "is-active" : ""}
              onClick={toggleOrdering}
            >
              {ordering ? "完成排序" : "调整顺序"}
            </Button>
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
        {moving
          ? "选择这篇论文要进入的领域。"
          : movingChecked
            ? `把选中的 ${dialogPaperIds.length} 篇论文移入哪个领域？`
            : ordering
              ? "用 ↑↓ 调整领域顺序，常用领域放前面；每次调整即时保存（⌘1-9 跟随新顺序）。"
              : "选择要查看的研究领域。"}
      </p>
      {moving && !ordering ? (
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
      {ordering ? (
        <div className="ef-domain-options ef-domain-ordering" aria-label="领域排序列表">
          {order.map((id, index) => {
            const domain = domains.find((item) => item.id === id);
            if (!domain) return null;
            return (
              <div key={id} className="ef-domain-option ef-order-row">
                <span>
                  <strong>{domain.name}</strong>
                  <small className="ef-domain-option-sum">
                    {domain.code}
                    {index < 9 ? ` · ⌘${index + 1}` : ""}
                  </small>
                </span>
                <span className="ef-order-actions">
                  <Button
                    type="button"
                    size="sm"
                    variant="text"
                    aria-label={`上移 ${domain.name}`}
                    disabled={index === 0}
                    onClick={() => moveOrder(id, -1)}
                  >
                    <Icon name="up" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="text"
                    aria-label={`下移 ${domain.name}`}
                    disabled={index === order.length - 1}
                    onClick={() => moveOrder(id, 1)}
                  >
                    <Icon name="down" />
                  </Button>
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <>
      <div className="ef-domain-filter">
        <Icon name="search" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onFilterKeyDown}
          placeholder="搜索领域名称或短码"
          aria-label="搜索领域"
          aria-keyshortcuts="ArrowUp ArrowDown Enter"
        />
        <small className="ef-domain-filter-hint" aria-hidden="true">
          ↑↓ 选择 · Enter 确认
        </small>
      </div>
      <div className="ef-domain-options" ref={listRef} role="list" aria-label="领域列表">
        {filtered.map((domain, index) => (
          <button
            key={domain.id}
            type="button"
            data-index={index}
            className={[
              "ef-domain-option",
              domain.id === selectedDomainId ? "is-current" : "",
              index === activeIndex ? "is-active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => pick(domain.id)}
            onMouseEnter={() => setActiveIndex(index)}
          >
            <span>
              <strong>{domain.name}</strong>
              {recentSet.has(domain.id) ? <i className="ef-domain-recent" aria-hidden="true">最近</i> : null}
              {domain.summary ? (
                <small className="ef-domain-option-sum">{domain.summary}</small>
              ) : null}
            </span>
            <span className="ef-domain-option-side">
              {census?.[domain.id] ? (
                <span className="ef-domain-option-stats mono">
                  {census[domain.id].total} 篇 · 已读 {census[domain.id].read}
                  {census[domain.id].reading ? ` · 在读 ${census[domain.id].reading}` : ""}
                  {formatDate(census[domain.id].lastReadAt) !== "—"
                    ? ` · 上次阅读 ${formatDate(census[domain.id].lastReadAt)}`
                    : ""}
                </span>
              ) : null}
              <span className="mono">
                {domain.code} <Icon name="right" />
              </span>
            </span>
          </button>
        ))}
        {filtered.length === 0 ? <p className="ef-domain-empty">没有匹配的领域。</p> : null}
      </div>
      {moving ? (
        <div className="ef-domain-create">
          {creating ? (
            <>
              <div className="ef-domain-create-row">
                <Icon name="plus" />
                <input
                  ref={createInputRef}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitCreate();
                    }
                  }}
                  placeholder="新领域名称，Enter 直接移入"
                  aria-label="新领域名称"
                  disabled={createBusy}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  disabled={createBusy}
                  onClick={() => void submitCreate()}
                >
                  {createBusy ? "移动中…" : "创建并移入"}
                </Button>
              </div>
              {createError ? <p className="ef-error">{createError}</p> : null}
            </>
          ) : (
            <button
              type="button"
              className="ef-domain-create-toggle"
              onClick={() => startCreate(keyword ? query.trim() : "")}
            >
              <Icon name="plus" />
              新建领域并移入
            </button>
          )}
        </div>
      ) : null}
        </>
      )}
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

/** 批量标签：为勾选集统一添加标签，或从整批移除已有标签（候选标签按覆盖篇数排序）。 */
export function TagCheckedPapersDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const checkedPaperIds = useField((s) => s.dialogPaperIds);
  const addTagsToChecked = useField((s) => s.addTagsToChecked);
  const removeTagsFromChecked = useField((s) => s.removeTagsFromChecked);
  const [input, setInput] = useState("");
  const [existing, setExisting] = useState<Array<{ tag: string; count: number }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = dialog === "tag-checked" && checkedPaperIds.length > 0;

  useEffect(() => {
    if (!open) {
      setInput("");
      setExisting([]);
      setError(null);
      return;
    }
    let alive = true;
    repo
      .tagsOfPapers(checkedPaperIds)
      .then((rows) => {
        if (alive) setExisting(rows);
      })
      .catch(() => {
        if (alive) setExisting([]);
      });
    return () => {
      alive = false;
    };
    // checkedPaperIds 是打开时冻结的快照，不会中途变化。
  }, [open, checkedPaperIds]);

  const pending = input
    .split(/[,，、;；]/)
    .map((tag) => tag.trim())
    .filter(Boolean);

  async function add() {
    if (busy) return;
    if (!pending.length) {
      setError("请先输入要添加的标签（逗号分隔，可一次多个）。");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await addTagsToChecked(pending);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(tag: string) {
    if (busy) return;
    setBusy(true);
    try {
      await removeTagsFromChecked([tag]);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Dialog
      open={open}
      title="批量修改标签"
      onClose={closeDialog}
      footer={
        <>
          <Button type="button" onClick={closeDialog}>
            取消
          </Button>
          <Button type="button" variant="primary" disabled={busy} onClick={() => void add()}>
            添加标签
          </Button>
        </>
      }
    >
      <p>
        将作用于选中的 <strong>{checkedPaperIds.length}</strong> 篇论文。标签写入后按「手动」来源保护，AI 补全不会覆盖。
      </p>
      <div className="ef-tag-batch-row">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="新标签，逗号分隔，如：benchmark, 综述"
          aria-label="要添加的标签"
          disabled={busy}
        />
      </div>
      {existing.length ? (
        <div className="ef-tag-batch-existing">
          <span className="ef-tag-batch-hint">这批论文已有的标签（点 × 从全部选中论文移除）：</span>
          <ul>
            {existing.map((item) => (
              <li key={item.tag}>
                <span>
                  {item.tag}
                  <small className="mono"> ×{item.count}</small>
                </span>
                <button
                  type="button"
                  aria-label={`移除标签 ${item.tag}`}
                  title={`从 ${item.count} 篇论文移除标签「${item.tag}」`}
                  disabled={busy}
                  onClick={() => void remove(item.tag)}
                >
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="ef-tag-batch-hint">这批论文还没有标签。</p>
      )}
      {error ? <p className="ef-error">{error}</p> : null}
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
  const attachPaperPdf = useField((s) => s.attachPaperPdf);
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
            onAttachPdf={(path) => attachPaperPdf(paper.id, path)}
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
  onAttachPdf,
}: {
  paper: PaperDetail;
  onDirtyChange?: (dirty: boolean) => void;
  /** 父级「保存全部并关闭」的句柄：挂载期间始终指向最新的 save 实现。 */
  saveRef?: React.MutableRefObject<(() => Promise<boolean>) | null>;
  /** 关联 / 替换本机 PDF 的落库动作（桌面端）；缺省（浏览器）时字段保持只读展示。 */
  onAttachPdf?: (path: string) => Promise<void>;
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
  // 关联 / 替换本机 PDF 的就地状态（桌面端按钮路径）。
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  async function pickAndAttachPdf() {
    if (!onAttachPdf || attaching) return;
    setAttachError(null);
    setAttaching(true);
    try {
      const selected = await pickPdfFiles(false);
      if (!selected?.[0]) return;
      await onAttachPdf(selected[0]);
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttaching(false);
    }
  }

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
        <input value={paper.pdfPath ?? "尚未关联本地 PDF"} readOnly title={paper.pdfPath ?? undefined} />
      </Field>
      {isTauri() && onAttachPdf ? (
        <div className="ef-pdf-attach">
          <Button type="button" size="sm" disabled={attaching} onClick={() => void pickAndAttachPdf()}>
            <Icon name="file" />
            {attaching ? "处理中…" : paper.pdfPath ? "替换 PDF 文件…" : "关联 PDF 文件…"}
          </Button>
          {/* 文件找不到了？同一个按钮就是重新定位入口：换一份文件重新关联。 */}
          {paper.pdfPath ? (
            <span className="ef-crew-paste-hint">文件缺失时可点「替换 PDF 文件…」重新定位。</span>
          ) : null}
        </div>
      ) : (
        <p className="ef-crew-paste-hint">浏览器预览不能读取本机 PDF；可在桌面应用中关联，或把文件拖进正文舞台。</p>
      )}
      {attachError ? <p className="ef-error ef-field-error">{attachError}</p> : null}
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
