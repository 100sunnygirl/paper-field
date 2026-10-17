import { create } from "zustand";
import { exportDomain } from "./lib/export";
import {
  DEFAULT_MINERU,
  loadMineruSettings,
  mineruProbe,
  saveMineruSettings,
  type MineruProviderKind,
  type MineruSaveInput,
  type MineruSettingsV2,
  type ProviderHealth,
} from "./lib/mineru";
import {
  cancelParses,
  dequeueFromBatch,
  enqueueBackfill,
  enqueueMineru,
  enqueueMineruBatch,
  forgetPapers,
  resumeMineru,
  stopBatch,
} from "./lib/mineruRun";
import { getActivity } from "./lib/activity";
import { cancelJob as cancelTrackedJob, jobDoneStep, runTracked } from "./lib/jobs";
import { pickProviderFromHealths, providerLabel, summarizeHealths } from "./lib/mineruPlan";
import { backupLibrary, restoreLibrary } from "./lib/backup";
import { DEFAULT_BIBLIO, loadBiblioSettings, saveBiblioSettings, type BiblioSaveInput, type BiblioStatus } from "./lib/biblio";
import { filledFrom, lookupPaper, type LookupResult, verifyReachable } from "./lib/lookup";
import { normalizeArxivId, normalizeDoi, safeHttpUrl, withDefaultScheme } from "./lib/urls";
import { DRAFT_NOTES_SYSTEM, PREPARE_META_SYSTEM, draftNotesUserPrompt, normalizeMeta, normalizeNotes, prepareMetaUserPrompt } from "./lib/prompts";
import { redactSecrets } from "./lib/redact";
import { repo } from "./lib/repo";
import { cancelChat, completeChat, hasUsableProvider, loadSettings, readLlmSettings, saveSettings, type LlmSaveInput } from "./lib/settings";
import { log } from "./lib/logger";
import { dismissAll, notify, type ToastAction } from "./toasts";
import type {
  AppMode,
  Domain,
  FieldStats,
  LlmJob,
  LlmSettings,
  NoteKind,
  OpenSource,
  PaperDetail,
  PaperListItem,
} from "./lib/types";
import { NOTE_KINDS } from "./lib/types";
import { extractJson } from "./lib/util";


interface Flash {
  tone: "ok" | "warn" | "error";
  text: string;
  action?: ToastAction;
}

interface FieldState {
  ready: boolean;
  error: string | null;
  /**
   * @deprecated 旧「全局单条」通知的镜像，只写不清（下一次 setFlash 才覆盖），
   * 仅服务既有测试的动作后立即断言（store.test / Dialogs.test / EditPaperDialog.test），
   * UI 已不再读取。新代码请直接用 toasts.notify / dismiss；测试断言迁移后删除本字段。
   */
  flash: Flash | null;
  mode: AppMode;
  domains: Domain[];
  selectedDomainId: string | null;
  papers: PaperListItem[];
  selectedPaperId: string | null;
  /** 列表批量选择模式：行点击改为勾选，配合工具栏做批量删除等操作。 */
  batchMode: boolean;
  /** 批量模式下勾选的论文 id；refresh 时会向当前列表裁剪（搜索/切换后不残留）。 */
  checkedPaperIds: string[];
  paper: PaperDetail | null;
  archive: PaperListItem[];
  intake: PaperListItem[];
  jobs: LlmJob[];
  stats: FieldStats;
  search: string;
  archiveFilter: OpenSource | "all";
  settings: LlmSettings;
  mineru: MineruSettingsV2;
  biblio: BiblioStatus;
  /** Settings files that exist but failed to load; the page shows defaults plus this error. */
  settingsLoadError: { mineru: string | null; biblio: string | null; llm: string | null; secrets: string | null };
  /** Quiet lookup hints for one paper. The dossier shows them only when that paper is open. */
  lookupHint: { paperId: string; notices: LookupResult["notices"] } | null;
  mineruHealth: ProviderHealth[];
  effectiveProvider: MineruProviderKind | null;
  dialog:
    | "paper"
    | "domain"
    | "confirm-notes"
    | "confirm-meta"
    | "edit-domain"
    | "move-paper"
    | "delete-paper"
    | "delete-checked"
    | "pick-domain"
    | "edit-paper"
    | null;
  /** 对话框打开时锁定的目标论文：之后选中怎么变，对话框都只作用于它。 */
  dialogPaperId: string | null;
  /** delete-checked 打开时冻结的勾选集。 */
  dialogPaperIds: string[];
  pendingDraftJob: string | null;
  /** 正在编辑、尚未保存的笔记草稿，按论文分开存：切换论文不丢，切回来还在。 */
  drafts: Record<string, Partial<Record<NoteKind, string>>>;
  loadError: string | null;
  /** 作业面板（状态条「作业」入口 / ⌘J）：非模态浮层，不拦截阅读区操作。 */
  jobsOpen: boolean;
  init: () => Promise<void>;
  setMode: (mode: AppMode) => Promise<void>;
  selectDomain: (id: string | null) => Promise<void>;
  selectPaper: (id: string | null) => Promise<void>;
  setSearch: (value: string) => Promise<void>;
  setArchiveFilter: (value: OpenSource | "all") => Promise<void>;
  /** reselect：当前选中不在新列表里时改选第一篇（切换模式等用户导航）；平时只在论文被删时回落。 */
  refresh: (options?: { reselect?: boolean }) => Promise<void>;
  /** target：论文对话框的目标论文（缺省为当前论文）；delete-checked 为冻结的勾选集。 */
  openDialog: (dialog: FieldState["dialog"], target?: string | string[]) => void;
  closeDialog: () => void;
  createDomain: (input: { name: string; code: string; summary?: string }) => Promise<void>;
  updateDomain: (input: { name: string; code: string; summary?: string }) => Promise<void>;
  deleteDomain: () => Promise<void>;
  importPdfs: (
    paths: string[],
    onProgress?: (done: number, total: number, current: string) => void,
    /** 导入到哪个领域；缺省为发起时选中的领域（重试时由闭包带上原领域）。 */
    domainId?: string,
  ) => Promise<void>;
  createManualPaper: (input: {
    title: string;
    arxivId?: string;
    doi?: string;
    pdfPath?: string;
  }) => Promise<void>;
  retryMineru: (paperId: string) => Promise<void>;
  /** INTAKE 页批量重试：把全部解析失败（error）论文重新提交给 MinerU。 */
  retryFailedMineru: () => Promise<void>;
  savePaperPatch: (paperId: string, patch: Parameters<typeof repo.updatePaper>[1]) => Promise<void>;
  saveAuthors: (paperId: string, authors: PaperDetail["authors"]) => Promise<void>;
  saveNote: (paperId: string, kind: NoteKind, content: string) => Promise<void>;
  /** 写入 / 清除（null）一块笔记草稿。 */
  setNoteDraft: (paperId: string, kind: NoteKind, value: string | null) => void;
  markRead: (paperId?: string) => Promise<void>;
  markReading: (paperId?: string) => Promise<void>;
  markUnread: (paperId?: string) => Promise<void>;
  setReadingStatus: (status: "unread" | "reading" | "read", paperId?: string) => Promise<void>;
  movePaper: (domainId: string, paperId?: string) => Promise<void>;
  deletePaper: (paperId?: string) => Promise<void>;
  setBatchMode: (on: boolean) => void;
  toggleCheckedPaper: (id: string) => void;
  setCheckedPaperIds: (ids: string[]) => void;
  /** 删除 delete-checked 对话框打开时冻结的那批论文。 */
  deleteCheckedPapers: () => Promise<void>;
  setJobsOpen: (open: boolean) => void;
  /** 作业面板「移出队列」：该篇轮到时直接跳过（不提交 MinerU），解析状态保持不变。 */
  dequeueMineruPaper: (batchId: number, paperId: string) => void;
  /** 作业面板「停止批次」：取消正在解析的一篇，并把本批其余排队论文移出队列。 */
  stopMineruBatch: (batchId: number) => Promise<void>;
  runPrepareMeta: (paperId?: string, overwrite?: boolean, quiet?: boolean, options?: { llm?: boolean }) => Promise<void>;
  runRefreshLinks: (paperId?: string) => Promise<void>;
  runDraftNotes: (paperId?: string, overwrite?: boolean) => Promise<void>;
  cancelJob: (jobId: string, options?: { silent?: boolean }) => Promise<void>;
  saveLlmSettings: (input: LlmSaveInput) => Promise<void>;
  saveMineruSettings: (input: MineruSaveInput) => Promise<void>;
  saveBiblioSettings: (input: BiblioSaveInput) => Promise<void>;
  probeMineru: () => Promise<ProviderHealth[]>;
  exportCurrentDomain: () => Promise<void>;
  backupLibrary: () => Promise<void>;
  restoreLibrary: () => Promise<void>;
  navigatePapers: (delta: number) => Promise<void>;
  setFlash: (flash: Flash | null) => void;
}

function currentList(state: FieldState): PaperListItem[] {
  if (state.mode === "archive") return state.archive;
  if (state.mode === "intake") return state.intake;
  return state.papers;
}

const IMPORT_FAILURES_SHOWN = 5;
/** Rust errors often carry full local paths; the toast keeps a short reason, the log keeps all of it. */
export const IMPORT_REASON_MAX = 60;

export function shortReason(message: string): string {
  const chars = [...message.replace(/\s+/g, " ").trim()];
  return chars.length > IMPORT_REASON_MAX ? `${chars.slice(0, IMPORT_REASON_MAX - 1).join("")}…` : chars.join("");
}

/** Every failed file (up to 5 in the toast, the rest counted), not just the first. */
export function importFailureList(failed: Array<{ name: string; message: string }>): string {
  const shown = failed.slice(0, IMPORT_FAILURES_SHOWN).map((f) => `${f.name}（${shortReason(f.message)}）`).join("、");
  const rest = failed.length - IMPORT_FAILURES_SHOWN;
  return rest > 0 ? `${shown} 等，另有 ${rest} 篇` : shown;
}

const prepareInflight = new Set<string>();
const refreshInflight = new Set<string>();
const draftInflight = new Set<string>();

export const SEARCH_DEBOUNCE_MS = 250;
let refreshSeq = 0;
/** 用户每次改选（点选论文、切领域、删除选中）加一；在途的 refresh 看到它变了就不改选中。 */
let selectionEpoch = 0;

const DRAFTS_KEY = "paper-field.note-drafts";

/** 草稿同步存一份到 localStorage：窗口意外重载也能找回。读写失败（隐私模式等）静默忽略。 */
function loadDrafts(): Record<string, Partial<Record<NoteKind, string>>> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(DRAFTS_KEY);
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    return value && typeof value === "object" ? (value as Record<string, Partial<Record<NoteKind, string>>>) : {};
  } catch {
    return {};
  }
}

function persistDrafts(drafts: Record<string, Partial<Record<NoteKind, string>>>): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (Object.keys(drafts).length) localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    else localStorage.removeItem(DRAFTS_KEY);
  } catch {
    // 存不下也不影响编辑：草稿仍在内存里。
  }
}

/** 这篇论文有没有尚未保存的笔记草稿。 */
export function hasDraft(state: Pick<FieldState, "drafts">, paperId: string | null | undefined): boolean {
  return Boolean(paperId && state.drafts[paperId] && Object.keys(state.drafts[paperId]!).length);
}
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchWaiters: { resolve: () => void; reject: (err: unknown) => void }[] = [];

export const useField = create<FieldState>((set, get) => ({
  ready: false,
  error: null,
  flash: null,
  mode: "field",
  domains: [],
  selectedDomainId: null,
  papers: [],
  selectedPaperId: null,
  batchMode: false,
  checkedPaperIds: [],
  paper: null,
  archive: [],
  intake: [],
  jobs: [],
  stats: { read: 0, total: 0, openSource: 0, queued: 0, running: 0 },
  search: "",
  archiveFilter: "all",
  settings: { version: 2, providers: [], usage: {} },
  mineru: DEFAULT_MINERU,
  biblio: DEFAULT_BIBLIO,
  settingsLoadError: { mineru: null, biblio: null, llm: null, secrets: null },
  lookupHint: null,
  mineruHealth: [],
  effectiveProvider: null,
  dialog: null,
  dialogPaperId: null,
  dialogPaperIds: [],
  pendingDraftJob: null,
  drafts: loadDrafts(),
  loadError: null,
  jobsOpen: false,

  // 【通知唯一入口 / 日志唯一收口】flash 字段的唯一写入口就是本函数：写入镜像的同时
  // 桥接 toasts 层（评审裁定的收口层）——非 null 走 notify（emit / refresh 等事件与
  // 日志联动都在那里），null 沿用旧语义「立即关掉当前通知」清空整个堆叠。
  // 任何代码不得绕过 setFlash 直接 setState({flash})，也不得绕过 notify 另发通知——
  // 否则会出现「有弹窗、无日志」的盲区（store.test.ts 有零 IPC + 收口防回归用例）。
  setFlash: (flash) => {
    set({ flash });
    if (flash) notify(flash.tone, flash.text, flash.action ? { action: flash.action } : undefined);
    else dismissAll("manual");
  },
  setNoteDraft: (paperId, kind, value) => {
    const drafts = { ...get().drafts };
    const forPaper = { ...(drafts[paperId] ?? {}) };
    if (value === null) delete forPaper[kind];
    else forPaper[kind] = value;
    if (Object.keys(forPaper).length) drafts[paperId] = forPaper;
    else delete drafts[paperId];
    set({ drafts });
    persistDrafts(drafts);
  },
  setJobsOpen: (open) => set({ jobsOpen: open }),

  dequeueMineruPaper: (batchId, paperId) => {
    // 只移出这一批；库里状态写成 cancelled，重启或保存 MinerU 设置后不会被重新提交。
    void dequeueFromBatch(batchId, paperId)
      .then(() => get().refresh())
      .catch((err) => log.error("mineru", "移出队列写库失败", err));
  },

  stopMineruBatch: async (batchId) => {
    const kind = getActivity().batches.find((item) => item.id === batchId)?.kind;
    const stopped = await stopBatch(batchId);
    await get().refresh();
    if (!kind) return;
    if (kind === "mineru") {
      log.info("mineru", `作业面板停止解析批次：${stopped} 篇不再写入`);
      get().setFlash({ tone: "ok", text: mineruStopCopy(stopped) });
    } else {
      log.info("llm", `作业面板停止 AI 补全批次：${stopped} 篇`);
      get().setFlash({ tone: "ok", text: `已停止补全，${stopped} 篇不再写入。` });
    }
  },
  openDialog: (dialog, target) => {
    const state = get();
    const paperScoped =
      dialog === "edit-paper" ||
      dialog === "delete-paper" ||
      dialog === "move-paper" ||
      dialog === "confirm-meta" ||
      dialog === "confirm-notes";
    set({
      dialog,
      dialogPaperId: paperScoped ? (typeof target === "string" ? target : state.paper?.id ?? state.selectedPaperId) : null,
      dialogPaperIds: dialog === "delete-checked" ? (Array.isArray(target) ? [...target] : [...state.checkedPaperIds]) : [],
    });
  },
  closeDialog: () => set({ dialog: null, dialogPaperId: null, dialogPaperIds: [], pendingDraftJob: null }),

  init: async () => {
    try {
      await repo.init();
      const settingsLoadError: { mineru: string | null; biblio: string | null; llm: string | null; secrets: string | null } = {
        mineru: null,
        biblio: null,
        llm: null,
        secrets: null,
      };
      const fallback = <T,>(key: "mineru" | "biblio", value: T) => (err: unknown): T => {
        settingsLoadError[key] = err instanceof Error ? err.message : String(err);
        log.error(key === "mineru" ? "mineru" : "store", key === "mineru" ? "MinerU 设置读取失败，已显示默认值" : "文献库设置读取失败，已显示默认值", err);
        return value;
      };
      const [domains, llmLoaded, mineru, biblio] = await Promise.all([
        repo.listDomains(),
        readLlmSettings(),
        loadMineruSettings().catch(fallback("mineru", DEFAULT_MINERU)),
        loadBiblioSettings().catch(fallback("biblio", DEFAULT_BIBLIO)),
      ]);
      const settings = llmLoaded.settings;
      settingsLoadError.llm = llmLoaded.llmError;
      settingsLoadError.secrets = llmLoaded.secretsError;
      const selectedDomainId = domains[0]?.id ?? null;
      set({ domains, selectedDomainId, settings, mineru, biblio, settingsLoadError, ready: true, error: null });
      await get().refresh();
      // 探测不阻断 ready：浏览器预览直接返回 []，桌面端最多 20s，完成后异步更新状态条。
      void get().probeMineru();
      enqueueMineru(() => resumeMineru(mineruHost()));
    } catch (err) {
      // init 失败渲染整页「存储无法打开」（不走 flash），收口覆盖不到，须单独记日志。
      log.error("store", "存储初始化失败", err);
      set({
        error: err instanceof Error ? err.message : String(err),
        ready: true,
      });
    }
  },

  refresh: async (options = {}) => {
    // Only the latest refresh may write: a slow earlier one (old search term,
    // previous domain/filter) must not overwrite newer results.
    const seq = ++refreshSeq;
    const state = get();
    const [stats, jobs, domains] = await Promise.all([
      repo.stats(),
      repo.listJobs(),
      repo.listDomains(),
    ]);
    let papers: PaperListItem[] = [];
    if (state.selectedDomainId) {
      papers = await repo.listPapers(state.selectedDomainId, state.search);
    }
    const archive = await repo.listArchive({
      search: state.mode === "archive" ? state.search : "",
      openSource: state.archiveFilter,
    });
    const intake = await repo.listIntake(state.mode === "intake" ? state.search : "");
    // 选中只随用户意图变化：以「现在」的选中为准（不是开始时的快照），论文还在库里就保持，
    // 只是不在当前筛选结果里也不改选；只有被删除、或用户导航要求重选时才回落到第一篇。
    const epoch = selectionEpoch;
    const now = get();
    const list = now.mode === "archive" ? archive : now.mode === "intake" ? intake : papers;
    let selectedPaperId = now.selectedPaperId;
    let paper = selectedPaperId ? await repo.getPaper(selectedPaperId) : null;
    const outOfList = Boolean(selectedPaperId) && !list.some((p) => p.id === selectedPaperId);
    if (now.mode !== "system" && (!paper || (options.reselect && outOfList))) {
      selectedPaperId = list[0]?.id ?? null;
      paper = selectedPaperId ? await repo.getPaper(selectedPaperId) : null;
    }
    if (seq !== refreshSeq) return;
    const latest = get();
    // 勾选集向当前列表裁剪（以现在的勾选为准，刷新期间取消的勾选不会被勾回来）。
    const visible = latest.mode === "archive" ? archive : latest.mode === "intake" ? intake : papers;
    const checkedPaperIds = latest.checkedPaperIds.filter((id) => visible.some((p) => p.id === id));
    if (epoch !== selectionEpoch) {
      // 刷新期间用户点了别的论文：列表照常更新，选中与详情以用户的选择为准。
      set({ stats, jobs, domains, papers, archive, intake, checkedPaperIds });
      return;
    }
    set({ stats, jobs, domains, papers, archive, intake, selectedPaperId, paper, checkedPaperIds });
  },

  setMode: async (mode) => {
    set({ mode });
    await get().refresh({ reselect: true });
  },

  selectDomain: async (id) => {
    try {
      selectionEpoch += 1;
      set({ selectedDomainId: id, selectedPaperId: null, paper: null, mode: "field", dialog: null, dialogPaperId: null, dialogPaperIds: [] });
      await get().refresh();
    } catch (err) {
      get().setFlash({ tone: "error", text: `切换领域失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  selectPaper: async (id) => {
    // 每次选择都换一个序号：慢的旧请求与在途的 refresh 都不能把选中改回去。
    const epoch = ++selectionEpoch;
    set({ selectedPaperId: id });
    const paper = id ? await repo.getPaper(id) : null;
    if (epoch !== selectionEpoch) return;
    set({ selectedPaperId: id, paper });
    if (paper && get().mode === "field") {
      set({ selectedDomainId: paper.domainId });
    }
  },

  setSearch: (value) => {
    // The input shows `value` at once; the query runs SEARCH_DEBOUNCE_MS after
    // the last keystroke. Every caller's promise settles when that refresh does.
    set({ search: value });
    if (searchTimer) clearTimeout(searchTimer);
    // Clearing the box restores the full list at once; there is nothing to debounce.
    const delay = value.trim() === "" ? 0 : SEARCH_DEBOUNCE_MS;
    return new Promise<void>((resolve, reject) => {
      searchWaiters.push({ resolve, reject });
      searchTimer = setTimeout(() => {
        searchTimer = null;
        const waiters = searchWaiters;
        searchWaiters = [];
        get()
          .refresh()
          .then(
            () => waiters.forEach((w) => w.resolve()),
            (err) => waiters.forEach((w) => w.reject(err)),
          );
      }, delay);
    });
  },

  setArchiveFilter: async (value) => {
    set({ archiveFilter: value });
    await get().refresh({ reselect: true });
  },

  createDomain: async (input) => {
    // 只有名称必填；短码留空时由 repo 自动生成（D-01 递增）。
    if (!input.name.trim()) {
      throw new Error("领域名称必填");
    }
    const domain = await repo.createDomain(input);
    set({ dialog: null, selectedDomainId: domain.id, mode: "field" });
    await get().refresh();
  },

  updateDomain: async (input) => {
    const id = get().selectedDomainId;
    if (!id) return;
    if (!input.name.trim()) {
      throw new Error("领域名称必填");
    }
    await repo.updateDomain(id, input);
    set({ dialog: null });
    await get().refresh();
  },

  deleteDomain: async () => {
    const id = get().selectedDomainId;
    if (!id) return;
    try {
      // 先取消这些论文的在途作业并移出排队，免得轮询在论文删掉后还占着队列、扣着配额。
      await forgetPapers(await repo.paperIdsInDomain(id));
      await repo.deleteDomain(id);
      const domains = await repo.listDomains();
      set({ selectedDomainId: domains[0]?.id ?? null, dialog: null, selectedPaperId: null, paper: null });
      await get().refresh();
    } catch (err) {
      get().setFlash({ tone: "error", text: `删除领域失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  importPdfs: async (paths, onProgress, targetDomainId) => {
    const domainId = targetDomainId ?? get().selectedDomainId;
    if (!domainId) throw new Error("请先选择一个领域，再导入 PDF。");
    const unique = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
    if (!unique.length) throw new Error("请选择至少一个 PDF");
    try {
      // 逐篇入库以回报真实进度（n/总数 · 当前文件）；单篇失败不中断整批。
      const created: PaperListItem["id"][] = [];
      let skippedCount = 0;
      const failed: Array<{ name: string; path: string; message: string }> = [];
      let done = 0;
      for (const path of unique) {
        const name = path.split(/[/\\]/).pop() ?? path;
        try {
          const result = await repo.importLocalPdfs(domainId, [path]);
          for (const paper of result.created) created.push(paper.id);
          skippedCount += result.skipped.length;
        } catch (err) {
          failed.push({ name, path, message: errText(err) });
        }
        done += 1;
        onProgress?.(done, unique.length, name);
      }
      // 只关导入对话框本身：长时间导入期间用户打开的其他对话框不被顺手关掉。
      if (get().dialog === "paper") set({ dialog: null });
      if (created[0]) selectionEpoch += 1;
      set({
        selectedPaperId: created[0] ?? get().selectedPaperId,
        mode: "field",
      });
      await get().refresh();
      const skippedText = skippedCount ? `，跳过 ${skippedCount} 篇已在库中` : "";
      for (const f of failed) log.warn("store", `PDF 导入失败：${f.name}`, f.message);
      if (failed.length) {
        get().setFlash({
          tone: "error",
          text: `已导入 ${created.length} 篇${skippedText}，${failed.length} 篇失败：${importFailureList(failed)}。${failed.length > 1 ? "完整失败列表见日志。" : ""}`,
          action: {
            label: failed.length > 1 ? `重试这 ${failed.length} 篇` : "重试",
            // Only the failed paths go back in; already-imported ones are not re-sent.
            run: () => {
              const retry = failed.map((f) => f.path);
              get()
                .importPdfs(retry, undefined, domainId)
                .catch((err) => get().setFlash({ tone: "error", text: `重试导入失败：${errText(err)}` }));
            },
          },
        });
      }
      if (!created.length) {
        if (!failed.length) get().setFlash({ tone: "warn", text: "这些 PDF 已在库中。" });
        return;
      }
      // 生效源判断：探测结果可能过期，无结果时先重探一次再下结论。
      let effective = get().effectiveProvider;
      if (!effective && get().mineru.configured) {
        effective = pickProviderFromHealths(get().mineru.order, await get().probeMineru());
      }
      if (!effective) {
        get().setFlash({
          tone: "warn",
          text: `已导入 ${created.length} 篇${skippedText}。当前没有可用的 MinerU 解析源，论文已入库但未解析，可到设置页启用解析源。`,
        });
        return;
      }
      if (!failed.length) {
        get().setFlash({
          tone: "ok",
          text: `已导入 ${created.length} 篇${skippedText}，正在用${providerLabel(effective)}解析。`,
        });
      }
      enqueueMineruBatch(mineruHost(), created, false);
    } catch (err) {
      get().setFlash({ tone: "error", text: `导入失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  createManualPaper: async (input) => {
    const domainId = get().selectedDomainId;
    if (!domainId) throw new Error("请先选择一个领域，再创建论文。");
    const title = input.title.trim();
    if (!title) throw new Error("标题必填");
    try {
      // 全角冒号、doi.org 链接等写法在入库前规整；认不出的保留原文，查询端会安全地忽略。
      const arxivId = input.arxivId?.trim() ? normalizeArxivId(input.arxivId) ?? input.arxivId.trim() : input.arxivId;
      const doi = input.doi?.trim() ? normalizeDoi(input.doi) ?? input.doi.trim() : input.doi;
      const pdf = input.pdfPath?.trim() ? await repo.adoptManualPdf(input.pdfPath.trim()) : null;
      const paper = await repo.createPaper({
        domainId,
        title,
        pdfPath: pdf?.libraryPath,
        pdfOriginalPath: pdf?.originalPath,
        arxivId,
        doi,
        userOwned: true,
      });
      set({ dialog: null, selectedPaperId: paper.id, mode: "field" });
      await get().refresh();
      get().setFlash({
        tone: "ok",
        text: paper.pdfPath ? `已创建「${title}」，正在查询文献库并安排解析。` : `已创建「${title}」，正在查询文献库。`,
      });
      // arXiv / DOI / title lookup runs even when there is no PDF and no API key.
      void get().runPrepareMeta(paper.id, false, true, { llm: !paper.pdfPath });
      if (paper.pdfPath) enqueueMineruBatch(mineruHost(), [paper.id], false);
    } catch (err) {
      get().setFlash({ tone: "error", text: `创建论文失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  retryMineru: async (paperId) => {
    if (!get().mineru.configured) {
      get().setFlash({ tone: "warn", text: "尚未启用任何 MinerU 解析源。可到设置页配置本地 / SSH / 官方 API。" });
      return;
    }
    // 探测结果可能过期：无生效源时先重探一次再下结论。
    if (!get().effectiveProvider) await get().probeMineru();
    if (!get().effectiveProvider) {
      const detail = summarizeHealths(get().mineru.order, get().mineruHealth);
      get().setFlash({
        tone: "warn",
        text: detail
          ? `当前没有可用的 MinerU 解析源（${detail}）。可到设置页查看失败原因。`
          : "当前没有可用的 MinerU 解析源（本地 / SSH / 官方 API 均未通过探测），可到设置页配置或查看失败原因。",
      });
      return;
    }
    try {
      // 跨源切换唯一入口：先取消旧的一轮，再重置 docRef/parseIds/provider 并收回所有权，
      // 以 force 重新提交，由后端按回退顺序重选源。旧的一轮之后写什么都不生效。
      await cancelParses([paperId]);
      await repo.resetMineru([paperId]);
      await get().refresh();
      get().setFlash({ tone: "ok", text: "已将这篇论文发送到 MinerU 解析。" });
      enqueueMineruBatch(mineruHost(), [paperId], true);
    } catch (err) {
      get().setFlash({ tone: "error", text: `重新解析失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  retryFailedMineru: async () => {
    let failedIds: string[] = [];
    try {
      failedIds = await repo.listFailedMineru();
    } catch (err) {
      get().setFlash({ tone: "error", text: `读取失败列表出错：${errText(err)}，数据未改动。` });
      throw err;
    }
    if (!failedIds.length) {
      get().setFlash({ tone: "warn", text: "没有解析失败的论文。" });
      return;
    }
    if (!get().mineru.configured) {
      get().setFlash({ tone: "warn", text: "尚未启用任何 MinerU 解析源。可到设置页配置本地 / SSH / 官方 API。" });
      return;
    }
    try {
      // 与单篇重试同构：重置解析状态后重新提交；连续失败由批次熔断兜底提示。
      await cancelParses(failedIds);
      await repo.resetMineru(failedIds);
      await get().refresh();
      get().setFlash({ tone: "ok", text: `已将 ${failedIds.length} 篇重新发送到 MinerU 解析。` });
      enqueueMineruBatch(mineruHost(), failedIds, true);
    } catch (err) {
      get().setFlash({ tone: "error", text: `批量重试失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  savePaperPatch: async (paperId, patch) => {
    try {
      await repo.updatePaper(paperId, patch, true);
      await get().refresh();
    } catch (err) {
      get().setFlash({ tone: "error", text: `保存论文信息失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  saveAuthors: async (paperId, authors) => {
    try {
      await repo.replaceAuthors(
        paperId,
        authors.map((author) => ({
          name: author.name,
          affiliation: author.affiliation,
          lab: author.lab,
          isCorresponding: author.isCorresponding,
        })),
        true,
      );
      await get().refresh();
    } catch (err) {
      get().setFlash({ tone: "error", text: `保存作者失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  saveNote: async (paperId, kind, content) => {
    try {
      await repo.updateNote(paperId, kind, content, "manual", true);
      get().setNoteDraft(paperId, kind, null);
      await get().refresh();
      get().setFlash({ tone: "ok", text: "笔记已保存。" });
    } catch (err) {
      get().setFlash({
        tone: "error",
        text: err instanceof Error ? `笔记保存失败：${err.message}` : "笔记保存失败，输入已保留，请重试。",
      });
      throw err;
    }
  },

  markRead: async (paperId) => {
    await get().setReadingStatus("read", paperId);
  },

  markReading: async (paperId) => {
    await get().setReadingStatus("reading", paperId);
  },

  markUnread: async (paperId) => {
    await get().setReadingStatus("unread", paperId);
  },

  setReadingStatus: async (status, paperId) => {
    const id = paperId ?? get().paper?.id ?? null;
    if (!id) return;
    try {
      await repo.setReadingStatus(id, status);
      await get().refresh();
      const labels = { unread: "未读", reading: "在读", read: "已读" };
      get().setFlash({ tone: "ok", text: `阅读状态已更新为${labels[status]}。` });
    } catch (err) {
      get().setFlash({ tone: "error", text: `更新阅读状态失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  movePaper: async (domainId, paperId) => {
    const id = paperId ?? get().dialogPaperId ?? get().selectedPaperId;
    if (!id) return;
    try {
      await repo.updatePaper(id, { domainId });
      selectionEpoch += 1;
      set({ dialog: null, dialogPaperId: null, selectedPaperId: id, selectedDomainId: domainId, mode: "field" });
      await get().refresh();
      const domain = get().domains.find((d) => d.id === domainId);
      get().setFlash({
        tone: "ok",
        text: domain ? `论文已移动到「${domain.name}」。` : "论文已移动到新领域。",
      });
    } catch (err) {
      get().setFlash({ tone: "error", text: `移动论文失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  deletePaper: async (paperId) => {
    const id = paperId ?? get().dialogPaperId ?? get().selectedPaperId;
    if (!id) return;
    try {
      await forgetPapers([id]);
      await repo.deletePaper(id);
      const drafts = { ...get().drafts };
      delete drafts[id];
      persistDrafts(drafts);
      const wasSelected = get().selectedPaperId === id;
      if (wasSelected) selectionEpoch += 1;
      set({
        drafts,
        dialog: null,
        dialogPaperId: null,
        ...(wasSelected ? { selectedPaperId: null, paper: null } : {}),
      });
      await get().refresh();
      get().setFlash({ tone: "ok", text: "论文已删除。" });
    } catch (err) {
      get().setFlash({ tone: "error", text: `删除论文失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  setBatchMode: (on) => {
    // 退出时清空勾选，避免下次进入批量模式残留旧选中。
    set(on ? { batchMode: true } : { batchMode: false, checkedPaperIds: [] });
  },

  toggleCheckedPaper: (id) => {
    const current = get().checkedPaperIds;
    set({
      checkedPaperIds: current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    });
  },

  setCheckedPaperIds: (ids) => set({ checkedPaperIds: ids }),

  deleteCheckedPapers: async () => {
    // 删的是对话框打开时冻结的那批：确认期间后台刷新改动勾选集也不影响。
    const frozen = get().dialogPaperIds;
    const ids = frozen.length ? [...frozen] : [...get().checkedPaperIds];
    if (!ids.length) return;
    try {
      await forgetPapers(ids);
      await repo.deletePapers(ids);
      const drafts = { ...get().drafts };
      for (const id of ids) delete drafts[id];
      persistDrafts(drafts);
      selectionEpoch += 1;
      set({
        drafts,
        dialog: null,
        dialogPaperIds: [],
        batchMode: false,
        checkedPaperIds: [],
        selectedPaperId: null,
        paper: null,
      });
      await get().refresh();
      get().setFlash({ tone: "ok", text: `已删除 ${ids.length} 篇论文。` });
    } catch (err) {
      get().setFlash({ tone: "error", text: `批量删除失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  runPrepareMeta: async (paperId, overwrite = false, quiet = false, options) => {
    const id = paperId ?? get().selectedPaperId;
    if (!id || prepareInflight.has(id)) return;
    prepareInflight.add(id);
    try {
      const paper = await repo.getPaper(id);
      if (!paper) return;
      const startedRev = paper.metaRev ?? 0;
      // 有 PDF 的手动建档只先查文献库：模型留到解析出全文之后再补，免得只凭标题补完就被标成「已补全」。
      const useLlm = options?.llm !== false && hasUsableProvider(get().settings);
      let foundMeta = false;
      // 查文献库与请求模型是同一个作业：两段都能在作业面板里看到、都能取消。
      const result = await runTracked(
        { type: "prepareMeta", paperId: id, prompt: null, stage: "request", auto: quiet, onCancel: cancelChat },
        async (ctx) => {
          const found = await lookupPaper(paper);
          await ctx.checkpoint();
          rememberLookup(set, get, id, found);
          foundMeta = Boolean(found.meta);
          if (found.meta) {
            const applied = await repo.applyPreparedMeta(id, found.meta, overwrite, {
              startedRev,
              source: "api",
              jobId: ctx.jobId,
            });
            if (applied === "cancelled") return "cancelled";
          }
          if (!useLlm) {
            await dropUnreachableLinks(id);
            const resultJson = found.meta ? JSON.stringify({ source: "api", confidence: found.meta.confidence ?? null }) : null;
            return (await repo.finishJob(ctx.jobId, "done", { resultJson })) ? "done" : "cancelled";
          }
          const fresh = (await repo.getPaper(id)) ?? paper;
          const prompt = prepareMetaUserPrompt({
            ...fresh,
            filledByApi: filledFrom(fresh.fieldSources, "api"),
          });
          const raw = await completeChat({ jobId: ctx.jobId, system: PREPARE_META_SYSTEM, user: prompt, signal: ctx.signal });
          await ctx.checkpoint();
          ctx.stage("apply");
          const meta = normalizeMeta(extractJson(raw));
          // 模型结果与「作业 → done」同一个事务：回写那一刻被取消就整批不写。
          const applied = await repo.applyPreparedMeta(id, meta, overwrite, {
            startedRev,
            source: "llm",
            jobId: ctx.jobId,
            finish: jobDoneStep(ctx.jobId, raw),
          });
          if (applied === "cancelled") return "cancelled";
          if (applied === "conflict" && !(await repo.finishJob(ctx.jobId, "done", { resultJson: raw }))) return "cancelled";
          await dropUnreachableLinks(id);
          return "done";
        },
      );
      await get().refresh();
      if (result.outcome === "error") {
        // 作业层已记「AI 作业失败」日志；这里只负责通知。
        const message = redactSecrets(result.error ?? "补全论文信息失败");
        if (!quiet) get().setFlash({ tone: "error", text: message });
      } else if (result.outcome === "done" && !quiet) {
        if (useLlm) get().setFlash({ tone: "ok", text: "AI 作业完成。阅读状态未改动。" });
        else if (!foundMeta) {
          get().setFlash({ tone: "warn", text: "尚未配置可用的 AI 服务。可到设置页添加提供商，或继续手动录入。" });
        }
      }
    } catch (err) {
      const message = redactSecrets(errText(err));
      log.error("llm", "补全论文信息失败", message);
      if (!quiet) get().setFlash({ tone: "error", text: message });
    } finally {
      prepareInflight.delete(id);
    }
  },

  runRefreshLinks: async (paperId) => {
    const id = paperId ?? get().selectedPaperId;
    if (!id || refreshInflight.has(id)) return;
    refreshInflight.add(id);
    const paper = await repo.getPaper(id);
    if (!paper) {
      refreshInflight.delete(id);
      return;
    }
    const startedRev = paper.metaRev ?? 0;
    let foundMeta = false;
    try {
      const result = await runTracked(
        { type: "refreshLinks", paperId: id, prompt: "bibliographic lookup", stage: "request" },
        async (ctx) => {
          // 刷新链接必须真的重新查询：跳过本地缓存。
          const found = await lookupPaper(paper, { force: true });
          await ctx.checkpoint();
          rememberLookup(set, get, id, found);
          foundMeta = Boolean(found.meta);
          if (found.meta) {
            const applied = await repo.applyPreparedMeta(id, found.meta, false, {
              startedRev,
              source: "api",
              jobId: ctx.jobId,
              replaceApi: true,
            });
            if (applied === "cancelled") return "cancelled";
          }
          await dropUnreachableLinks(id);
          const resultJson = found.meta ? JSON.stringify({ source: "api", confidence: found.meta.confidence ?? null }) : null;
          return (await repo.finishJob(ctx.jobId, "done", { resultJson })) ? "done" : "cancelled";
        },
      );
      if (result.outcome === "done") {
        get().setFlash({ tone: "ok", text: foundMeta ? "已从文献库刷新著录。" : "文献库暂时不可用，已保留现有著录。" });
      } else if (result.outcome === "error") {
        get().setFlash({ tone: "error", text: redactSecrets(result.error ?? "刷新链接失败") });
      }
    } catch (err) {
      get().setFlash({ tone: "error", text: `刷新链接失败：${errText(err)}` });
    } finally {
      refreshInflight.delete(id);
      await get().refresh();
    }
  },

  runDraftNotes: async (paperId, overwrite = false) => {
    const id = paperId ?? get().selectedPaperId;
    if (!id || draftInflight.has(id)) return;
    if (!hasUsableProvider(get().settings)) {
      get().setFlash({ tone: "warn", text: "尚未配置可用的 AI 服务。可到设置页添加提供商后再起草阅读笔记。" });
      return;
    }
    // 先占在途锁再读库：双击时第二次调用在这里就返回。
    draftInflight.add(id);
    const paper = await repo.getPaper(id);
    if (!paper || (paper.userNotesTouched && !overwrite)) {
      draftInflight.delete(id);
      if (paper) set({ dialog: "confirm-notes", dialogPaperId: id, pendingDraftJob: id });
      return;
    }
    if (get().dialog === "confirm-notes") set({ dialog: null, dialogPaperId: null, pendingDraftJob: null });
    const prompt = draftNotesUserPrompt(paper);
    // 记下此刻每块笔记的版本号：请求期间被改过的块回写时整块跳过。
    const revs = Object.fromEntries(NOTE_KINDS.map((kind) => [kind, paper.notes?.[kind]?.rev ?? 0])) as Record<NoteKind, number>;
    try {
      const result = await runTracked(
        { type: "draftNotes", paperId: id, prompt, stage: "request", onCancel: cancelChat },
        async (ctx) => {
          await get().refresh();
          const raw = await completeChat({ jobId: ctx.jobId, system: DRAFT_NOTES_SYSTEM, user: prompt, signal: ctx.signal });
          await ctx.checkpoint();
          ctx.stage("apply");
          const notes = normalizeNotes(extractJson(raw));
          const kept = await repo.applyDraftedNotes(id, notes, overwrite, revs, jobDoneStep(ctx.jobId, raw));
          if (kept === null) return "cancelled";
          const editedDuring = kept.filter((kind) => overwrite || !paper.notes?.[kind]?.userEdited);
          if (editedDuring.length) {
            get().setFlash({
              tone: "warn",
              text: `起草期间你修改了 ${editedDuring.length} 块笔记，这些块保留你的内容，其余已写入 AI 草稿。`,
            });
          } else {
            get().setFlash({ tone: "ok", text: "AI 作业完成。阅读状态未改动。" });
          }
          return "done";
        },
      );
      if (result.outcome === "error") {
        get().setFlash({ tone: "error", text: redactSecrets(result.error ?? "起草阅读笔记失败") });
      }
    } catch (err) {
      get().setFlash({ tone: "error", text: `起草阅读笔记失败：${errText(err)}` });
    } finally {
      draftInflight.delete(id);
      await get().refresh();
    }
  },

  cancelJob: async (jobId, options) => {
    const job = get().jobs.find((item) => item.id === jobId);
    await cancelTrackedJob(jobId, job ? { paperId: job.paperId, type: job.type } : undefined);
    if (job?.type === "mineruParse" && !options?.silent) get().setFlash({ tone: "ok", text: mineruStopCopy(1) });
    await get().refresh();
  },

  saveLlmSettings: async (input) => {
    try {
      await saveSettings(input);
      const settings = await loadSettings();
      set({ settings });
      const usable = hasUsableProvider(settings);
      get().setFlash({
        tone: usable ? "ok" : "warn",
        text: usable
          ? "AI 服务设置已保存。"
          : "已保存提供商列表，但当前没有可用的 AI 服务：请启用并填写 API Key，或使用免 Key 的本地服务。",
      });
      if (usable) enqueueBackfill(mineruHost());
    } catch (err) {
      get().setFlash({ tone: "error", text: `保存 AI 服务设置失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  saveBiblioSettings: async (input) => {
    try {
      const saved = await saveBiblioSettings(input);
      const current = get().biblio;
      set({
        biblio: {
          ...saved,
          openalexRemainingUsd: saved.openalexRemainingUsd ?? current.openalexRemainingUsd,
          openalexLimitUsd: saved.openalexLimitUsd ?? current.openalexLimitUsd,
        },
      });
      get().setFlash({ tone: "ok", text: "文献库设置已保存。没有填写邮箱或 Key 时仍会查询，只是走公共额度。" });
    } catch (err) {
      get().setFlash({ tone: "error", text: `保存文献库设置失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  saveMineruSettings: async (input) => {
    try {
      const mineru = await saveMineruSettings(input);
      set({ mineru });
      get().setFlash({
        tone: mineru.configured ? "ok" : "warn",
        text: mineru.configured ? "MinerU 设置已保存，正在重新探测各解析源。" : "已保存，尚未启用任何解析源。",
      });
      // 保存成功后重探（异步，不阻塞返回）；浏览器预览 resolve [] 不抛错。
      void get().probeMineru();
      if (mineru.configured) enqueueMineru(() => resumeMineru(mineruHost()));
    } catch (err) {
      get().setFlash({ tone: "error", text: `保存 MinerU 设置失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  probeMineru: async () => {
    const healths = await mineruProbe();
    const mineru = get().mineru;
    set({
      mineruHealth: healths,
      effectiveProvider: pickProviderFromHealths(mineru.order, healths),
    });
    return healths;
  },

  backupLibrary: async () => {
    try {
      const where = await backupLibrary();
      if (!where) return;
      get().setFlash({ tone: "ok", text: `已备份到 ${where}` });
    } catch (err) {
      if (String(err).includes("DESKTOP_ONLY")) {
        get().setFlash({ tone: "warn", text: "备份与恢复仅在桌面版可用。" });
        return;
      }
      get().setFlash({ tone: "error", text: `备份失败：${errText(err)}` });
    }
  },

  restoreLibrary: async () => {
    try {
      const restored = await restoreLibrary();
      if (!restored) return;
      get().setFlash({ tone: "ok", text: "已恢复文库，正在重新载入。" });
    } catch (err) {
      if (String(err).includes("DESKTOP_ONLY")) {
        get().setFlash({ tone: "warn", text: "备份与恢复仅在桌面版可用。" });
        return;
      }
      get().setFlash({ tone: "error", text: `恢复失败：${errText(err)}` });
    }
  },

  exportCurrentDomain: async () => {
    const domainId = get().selectedDomainId;
    if (!domainId) return;
    const domain = await repo.getDomain(domainId);
    if (!domain) return;
    const papers = await repo.papersForExport(domainId);
    try {
      const where = await exportDomain(domain, papers);
      get().setFlash({ tone: "ok", text: `已导出 ${papers.length} 篇 · ${where}` });
    } catch (err) {
      if (String(err).includes("EXPORT_CANCELLED")) return;
      get().setFlash({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    }
  },

  navigatePapers: async (delta) => {
    if (get().mode === "system") return;
    const list = currentList(get());
    if (!list.length) return;
    // 未选中论文时，↓ 直接落到第 1 篇、↑ 落到最后一篇，而不是跳过第 1 篇。
    const idx = list.findIndex((p) => p.id === get().selectedPaperId);
    const index =
      idx === -1
        ? delta > 0
          ? 0
          : list.length - 1
        : Math.min(list.length - 1, Math.max(0, idx + delta));
    const next = list[index];
    if (next) await get().selectPaper(next.id);
  },
}));

function rememberLookup(
  set: (partial: Partial<FieldState>) => void,
  get: () => FieldState,
  paperId: string,
  result: LookupResult,
) {
  const hint = result.notices.length ? { paperId, notices: result.notices } : null;
  const current = get().lookupHint;
  const biblio = get().biblio;
  const budgetKnown = result.openalexRemainingUsd != null || result.openalexLimitUsd != null;
  set({
    lookupHint: hint ?? (current?.paperId === paperId ? null : current),
    ...(budgetKnown
      ? {
          biblio: {
            ...biblio,
            openalexRemainingUsd: result.openalexRemainingUsd,
            openalexLimitUsd: result.openalexLimitUsd,
          },
        }
      : {}),
  });
}

function mineruHost() {
  return {
    mineru: () => useField.getState().mineru,
    // 门禁派生口径：任一 enabled 且（requiresKey ? 已存 Key : 免 Key）的提供商。
    hasKey: () => hasUsableProvider(useField.getState().settings),
    refresh: () => useField.getState().refresh(),
    flash: (tone: "ok" | "warn" | "error", text: string) => useField.getState().setFlash({ tone, text }),
    prepare: (paperId: string, overwrite: boolean, quiet: boolean) =>
      useField.getState().runPrepareMeta(paperId, overwrite, quiet),
  };
}

function mineruStopCopy(count: number): string {
  return `已在本机停止解析，${count} 篇不再写入。远端任务不撤回，可能仍在继续，配额或页数可能已经计入。`;
}

function errText(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

async function dropUnreachableLinks(paperId: string): Promise<void> {
  const paper = await repo.getPaper(paperId);
  if (!paper) return;
  for (const key of ["codeUrl", "projectPage"] as const) {
    const raw = paper[key];
    if (!raw || paper.fieldSources?.[key] === "user") continue;
    // Schemeless AI links (`github.com/x`) are stored as https:// only if reachable.
    const url = withDefaultScheme(raw);
    let next: string | null | undefined;
    // Not an http(s) URL even after completion (`localhost:3000`, `v1`): drop without probing.
    if (!safeHttpUrl(url)) {
      next = null;
    } else {
      const reach = await verifyReachable(url);
      if (url !== raw.trim()) {
        // A prefix we added is a guess (`v1.2` -> https://v1.2): keep it only when proven reachable.
        next = reach === "reachable" ? url : null;
      } else if (reach === "unreachable") {
        next = null;
      }
    }
    // 校验可能要十几秒：期间用户改过这个链接就不再动它（条件写入）。
    if (next !== undefined && next !== raw) await repo.replaceLinkIf(paperId, key, raw, next);
  }
}
