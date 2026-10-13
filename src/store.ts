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
  backfillMeta,
  cancelMineruPaper,
  clearMineruCancel,
  enqueueMineru,
  enqueueMineruBatch,
  resumeMineru,
} from "./lib/mineruRun";
import { endBatchItem, endJob, getActivity, trackJob, type JobOutcome } from "./lib/activity";
import { pickProviderFromHealths, providerLabel, summarizeHealths } from "./lib/mineruPlan";
import { backupLibrary, restoreLibrary } from "./lib/backup";
import { DEFAULT_BIBLIO, loadBiblioSettings, saveBiblioSettings, type BiblioSaveInput, type BiblioStatus } from "./lib/biblio";
import { filledFrom, lookupPaper, type LookupResult, verifyReachable } from "./lib/lookup";
import { DRAFT_NOTES_SYSTEM, PREPARE_META_SYSTEM, draftNotesUserPrompt, normalizeMeta, normalizeNotes, prepareMetaUserPrompt } from "./lib/prompts";
import { redactSecrets } from "./lib/redact";
import { repo } from "./lib/repo";
import { cancelChat, completeChat, hasUsableProvider, loadSettings, saveSettings, type LlmSaveInput } from "./lib/settings";
import { log } from "./lib/logger";
import { dismissAll, notify } from "./toasts";
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
import { extractJson, nowIso } from "./lib/util";

const abortMap = new Map<string, AbortController>();

interface Flash {
  tone: "ok" | "warn" | "error";
  text: string;
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
  pendingDraftJob: string | null;
  unsavedNote: boolean;
  loadError: string | null;
  /** 作业面板（状态条「作业」入口 / ⌘J）：非模态浮层，不拦截阅读区操作。 */
  jobsOpen: boolean;
  init: () => Promise<void>;
  setMode: (mode: AppMode) => Promise<void>;
  selectDomain: (id: string | null) => Promise<void>;
  selectPaper: (id: string | null) => Promise<void>;
  setSearch: (value: string) => Promise<void>;
  setArchiveFilter: (value: OpenSource | "all") => Promise<void>;
  refresh: () => Promise<void>;
  openDialog: (dialog: FieldState["dialog"]) => void;
  closeDialog: () => void;
  createDomain: (input: { name: string; code: string; summary?: string }) => Promise<void>;
  updateDomain: (input: { name: string; code: string; summary?: string }) => Promise<void>;
  deleteDomain: () => Promise<void>;
  importPdfs: (
    paths: string[],
    onProgress?: (done: number, total: number, current: string) => void,
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
  savePaperPatch: (patch: Parameters<typeof repo.updatePaper>[1]) => Promise<void>;
  saveAuthors: (authors: PaperDetail["authors"]) => Promise<void>;
  saveNote: (kind: NoteKind, content: string) => Promise<void>;
  markRead: () => Promise<void>;
  markReading: () => Promise<void>;
  markUnread: () => Promise<void>;
  setReadingStatus: (status: "unread" | "reading" | "read") => Promise<void>;
  movePaper: (domainId: string) => Promise<void>;
  deletePaper: () => Promise<void>;
  setBatchMode: (on: boolean) => void;
  toggleCheckedPaper: (id: string) => void;
  setCheckedPaperIds: (ids: string[]) => void;
  /** 删除当前勾选的全部论文（先经 delete-checked 对话框确认）。 */
  deleteCheckedPapers: () => Promise<void>;
  setUnsavedNote: (value: boolean) => void;
  setJobsOpen: (open: boolean) => void;
  /** 作业面板「移出队列」：该篇轮到时直接跳过（不提交 MinerU），解析状态保持不变。 */
  dequeueMineruPaper: (batchId: number, paperId: string) => void;
  /** 作业面板「停止批次」：取消正在解析的一篇，并把本批其余排队论文移出队列。 */
  stopMineruBatch: (batchId: number) => Promise<void>;
  runPrepareMeta: (paperId?: string, overwrite?: boolean, quiet?: boolean) => Promise<void>;
  runRefreshLinks: (paperId?: string) => Promise<void>;
  runDraftNotes: (paperId?: string, overwrite?: boolean) => Promise<void>;
  cancelJob: (jobId: string) => Promise<void>;
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

export const SEARCH_DEBOUNCE_MS = 250;
let refreshSeq = 0;
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
  lookupHint: null,
  mineruHealth: [],
  effectiveProvider: null,
  dialog: null,
  pendingDraftJob: null,
  unsavedNote: false,
  loadError: null,
  jobsOpen: false,

  // 【通知唯一入口 / 日志唯一收口】flash 字段的唯一写入口就是本函数：写入镜像的同时
  // 桥接 toasts 层（评审裁定的收口层）——非 null 走 notify（emit / refresh 等事件与
  // 日志联动都在那里），null 沿用旧语义「立即关掉当前通知」清空整个堆叠。
  // 任何代码不得绕过 setFlash 直接 setState({flash})，也不得绕过 notify 另发通知——
  // 否则会出现「有弹窗、无日志」的盲区（store.test.ts 有零 IPC + 收口防回归用例）。
  setFlash: (flash) => {
    set({ flash });
    if (flash) notify(flash.tone, flash.text);
    else dismissAll("manual");
  },
  setUnsavedNote: (value) => set({ unsavedNote: value }),
  setJobsOpen: (open) => set({ jobsOpen: open }),

  dequeueMineruPaper: (batchId, paperId) => {
    // 复用 mineruRun 的取消集合：processOne 轮到该篇时先查取消标记、直接返回 cancelled，
    // 不建作业也不改论文的解析状态；实况这边立即记为已取消，面板与状态条同步出列。
    cancelMineruPaper(paperId);
    endBatchItem(batchId, paperId, "cancelled");
  },

  stopMineruBatch: async (batchId) => {
    const batch = getActivity().batches.find((item) => item.id === batchId);
    if (!batch || batch.kind !== "mineru") return;
    const pending = batch.paperIds.filter(
      (id) => !batch.results[id] && id !== batch.currentPaperId,
    );
    for (const id of pending) get().dequeueMineruPaper(batchId, id);
    const current = batch.currentPaperId;
    let stopped = pending.length;
    if (current) {
      const active = get().jobs.filter(
        (job) => job.paperId === current && (job.status === "queued" || job.status === "running"),
      );
      // 当前一篇已建作业（解析或解析后的自动补全）→ 走既有取消；尚未建作业 → 打取消标记。
      if (active.length) {
        for (const job of active) await get().cancelJob(job.id);
      } else {
        cancelMineruPaper(current);
      }
      stopped += 1;
    }
    log.info("mineru", `作业面板停止解析批次：${stopped} 篇不再处理`);
    get().setFlash({ tone: "ok", text: `已停止本批解析，${stopped} 篇不再处理。可在资料栏单独重新解析。` });
  },
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null, pendingDraftJob: null }),

  init: async () => {
    try {
      await repo.init();
      const [domains, settings, mineru, biblio] = await Promise.all([
        repo.listDomains(),
        loadSettings(),
        loadMineruSettings().catch(() => DEFAULT_MINERU),
        loadBiblioSettings().catch(() => DEFAULT_BIBLIO),
      ]);
      const selectedDomainId = domains[0]?.id ?? null;
      set({ domains, selectedDomainId, settings, mineru, biblio, ready: true, error: null });
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

  refresh: async () => {
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
    const selectedPaperId =
      state.selectedPaperId &&
      (state.mode === "field" ? papers : state.mode === "archive" ? archive : intake).some(
        (p) => p.id === state.selectedPaperId,
      )
        ? state.selectedPaperId
        : (state.mode === "field" ? papers : state.mode === "archive" ? archive : intake)[0]?.id ??
          null;
    const paper = selectedPaperId ? await repo.getPaper(selectedPaperId) : null;
    // 勾选集向当前列表裁剪：搜索词变化、切换领域/模式后，已不可见的论文不再参与批量操作。
    const checkedPaperIds = state.checkedPaperIds.filter((id) =>
      (state.mode === "archive" ? archive : state.mode === "intake" ? intake : papers).some(
        (p) => p.id === id,
      ),
    );
    if (seq !== refreshSeq) return;
    set({ stats, jobs, domains, papers, archive, intake, selectedPaperId, paper, checkedPaperIds });
  },

  setMode: async (mode) => {
    if (!guardUnsaved(get)) return;
    set({ mode });
    await get().refresh();
  },

  selectDomain: async (id) => {
    if (!guardUnsaved(get)) return;
    try {
      set({ selectedDomainId: id, selectedPaperId: null, paper: null, mode: "field", dialog: null });
      await get().refresh();
    } catch (err) {
      get().setFlash({ tone: "error", text: `切换领域失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  selectPaper: async (id) => {
    if (id && !guardUnsaved(get)) return;
    const paper = id ? await repo.getPaper(id) : null;
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
      }, SEARCH_DEBOUNCE_MS);
    });
  },

  setArchiveFilter: async (value) => {
    set({ archiveFilter: value });
    await get().refresh();
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
      await repo.deleteDomain(id);
      const domains = await repo.listDomains();
      set({ selectedDomainId: domains[0]?.id ?? null, dialog: null, selectedPaperId: null, paper: null });
      await get().refresh();
    } catch (err) {
      get().setFlash({ tone: "error", text: `删除领域失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  importPdfs: async (paths, onProgress) => {
    const domainId = get().selectedDomainId;
    if (!domainId) throw new Error("请先选择一个领域，再导入 PDF。");
    const unique = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
    if (!unique.length) throw new Error("请选择至少一个 PDF");
    try {
      // 逐篇入库以回报真实进度（n/总数 · 当前文件）；单篇失败不中断整批。
      const created: PaperListItem["id"][] = [];
      let skippedCount = 0;
      const failed: Array<{ name: string; message: string }> = [];
      let done = 0;
      for (const path of unique) {
        const name = path.split(/[/\\]/).pop() ?? path;
        try {
          const result = await repo.importLocalPdfs(domainId, [path]);
          for (const paper of result.created) created.push(paper.id);
          skippedCount += result.skipped.length;
        } catch (err) {
          failed.push({ name, message: errText(err) });
        }
        done += 1;
        onProgress?.(done, unique.length, name);
      }
      set({
        dialog: null,
        selectedPaperId: created[0] ?? get().selectedPaperId,
        mode: "field",
      });
      await get().refresh();
      const skippedText = skippedCount ? `，跳过 ${skippedCount} 篇已在库中` : "";
      if (failed.length) {
        get().setFlash({
          tone: "error",
          text: `已导入 ${created.length} 篇${skippedText}，${failed.length} 篇失败：${failed[0].name}（${failed[0].message}）。`,
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
      const paper = await repo.createPaper({
        domainId,
        title,
        pdfPath: input.pdfPath,
        arxivId: input.arxivId,
        doi: input.doi,
        userOwned: true,
      });
      set({ dialog: null, selectedPaperId: paper.id, mode: "field" });
      await get().refresh();
      get().setFlash({
        tone: "ok",
        text: paper.pdfPath ? `已创建「${title}」，正在查询文献库并安排解析。` : `已创建「${title}」，正在查询文献库。`,
      });
      // arXiv / DOI / title lookup runs even when there is no PDF and no API key.
      void get().runPrepareMeta(paper.id, false, true);
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
      clearMineruCancel(paperId);
      // 跨源切换唯一入口：重置 docRef/parseIds/provider 后以 provider=null 重新提交，
      // 由后端按回退顺序重选源并更新论文记录的解析来源。
      await repo.setMineruState(paperId, {
        status: "queued",
        error: null,
        parseId: null,
        parseIds: [],
        docRef: null,
        provider: null,
      });
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
      for (const id of failedIds) {
        clearMineruCancel(id);
        await repo.setMineruState(id, {
          status: "queued",
          error: null,
          parseId: null,
          parseIds: [],
          docRef: null,
          provider: null,
        });
      }
      await get().refresh();
      get().setFlash({ tone: "ok", text: `已将 ${failedIds.length} 篇重新发送到 MinerU 解析。` });
      enqueueMineruBatch(mineruHost(), failedIds, true);
    } catch (err) {
      get().setFlash({ tone: "error", text: `批量重试失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  savePaperPatch: async (patch) => {
    const id = get().selectedPaperId;
    if (!id) return;
    try {
      await repo.updatePaper(id, patch, true);
      await get().refresh();
    } catch (err) {
      get().setFlash({ tone: "error", text: `保存论文信息失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  saveAuthors: async (authors) => {
    const id = get().selectedPaperId;
    if (!id) return;
    try {
      await repo.replaceAuthors(
        id,
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

  saveNote: async (kind, content) => {
    const id = get().selectedPaperId;
    if (!id) throw new Error("未选择论文");
    try {
      await repo.updateNote(id, kind, content, "manual", true);
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

  markRead: async () => {
    await get().setReadingStatus("read");
  },

  markReading: async () => {
    await get().setReadingStatus("reading");
  },

  markUnread: async () => {
    await get().setReadingStatus("unread");
  },

  setReadingStatus: async (status) => {
    const id = get().selectedPaperId;
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

  movePaper: async (domainId) => {
    const id = get().selectedPaperId;
    if (!id) return;
    try {
      await repo.updatePaper(id, { domainId });
      set({ dialog: null, selectedDomainId: domainId, mode: "field" });
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

  deletePaper: async () => {
    const id = get().selectedPaperId;
    if (!id) return;
    try {
      await repo.deletePaper(id);
      set({ selectedPaperId: null, paper: null, dialog: null, unsavedNote: false });
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
    const ids = [...get().checkedPaperIds];
    if (!ids.length) return;
    try {
      await repo.deletePapers(ids);
      set({
        dialog: null,
        batchMode: false,
        checkedPaperIds: [],
        selectedPaperId: null,
        paper: null,
        unsavedNote: false,
      });
      await get().refresh();
      get().setFlash({ tone: "ok", text: `已删除 ${ids.length} 篇论文。` });
    } catch (err) {
      get().setFlash({ tone: "error", text: `批量删除失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  runPrepareMeta: async (paperId, overwrite = false, quiet = false) => {
    const id = paperId ?? get().selectedPaperId;
    if (!id) return;
    try {
      const paper = await repo.getPaper(id);
      if (!paper) return;
      const startedRev = paper.metaRev ?? 0;
      const found = await lookupPaper(paper);
      rememberLookup(set, get, id, found);
      if (found.meta) {
        await repo.applyPreparedMeta(id, found.meta, overwrite, { startedRev, source: "api" });
      }
      if (!hasUsableProvider(get().settings)) {
        await dropUnreachableLinks(id);
        await get().refresh();
        if (!quiet && !found.meta) {
          get().setFlash({ tone: "warn", text: "尚未配置可用的 AI 服务。可到设置页添加提供商，或继续手动录入。" });
        }
        return;
      }
      const fresh = (await repo.getPaper(id)) ?? paper;
      const prompt = prepareMetaUserPrompt({
        ...fresh,
        filledByApi: filledFrom(fresh.fieldSources, "api"),
      });
      const job = await repo.createJob(id, "prepareMeta", prompt);
      await get().refresh();
      await runJob(job.id, id, PREPARE_META_SYSTEM, prompt, async (raw) => {
        const meta = normalizeMeta(extractJson(raw), fresh.title);
        await repo.applyPreparedMeta(id, meta, overwrite, { startedRev, source: "llm", jobId: job.id });
        await dropUnreachableLinks(id);
      }, quiet);
    } catch (err) {
      const message = redactSecrets(errText(err));
      log.error("llm", "补全论文信息失败", message);
      if (!quiet) get().setFlash({ tone: "error", text: message });
    }
  },

  runRefreshLinks: async (paperId) => {
    const id = paperId ?? get().selectedPaperId;
    if (!id) return;
    const paper = await repo.getPaper(id);
    if (!paper) return;
    const startedRev = paper.metaRev ?? 0;
    const job = await repo.createJob(id, "refreshLinks", "bibliographic lookup");
    await get().refresh();
    const started = await repo.updateJob(job.id, { status: "running", startedAt: nowIso() });
    if (started === false) return;
    trackJob(job.id, id, "request");
    try {
      if ((await jobStillRunning(job.id)) === false) return;
      const found = await lookupPaper(paper);
      rememberLookup(set, get, id, found);
      if ((await jobStillRunning(job.id)) === false) return;
      if (found.meta) {
        await repo.applyPreparedMeta(id, found.meta, false, {
          startedRev,
          source: "api",
          jobId: job.id,
          replaceApi: true,
        });
      }
      await dropUnreachableLinks(id);
      const finished = await repo.updateJob(job.id, {
        status: "done",
        resultJson: found.meta ? JSON.stringify({ source: "api", confidence: found.meta.confidence ?? null }) : null,
        finishedAt: nowIso(),
      });
      if (finished === false) return;
      endJob(job.id, "done");
      get().setFlash({ tone: "ok", text: found.meta ? "已从文献库刷新著录。" : "文献库暂时不可用，已保留现有著录。" });
    } catch (err) {
      const message = redactSecrets(errText(err));
      const marked = await repo.updateJob(job.id, { status: "error", error: message, finishedAt: nowIso() });
      endJob(job.id, marked === false ? "cancelled" : "error");
      if (marked !== false) get().setFlash({ tone: "error", text: message });
    } finally {
      await get().refresh();
    }
  },

  runDraftNotes: async (paperId, overwrite = false) => {
    const id = paperId ?? get().selectedPaperId;
    if (!id) return;
    if (!hasUsableProvider(get().settings)) {
      get().setFlash({ tone: "warn", text: "尚未配置可用的 AI 服务。可到设置页添加提供商后再起草阅读笔记。" });
      return;
    }
    const paper = await repo.getPaper(id);
    if (!paper) return;
    if (paper.userNotesTouched && !overwrite) {
      set({ dialog: "confirm-notes", pendingDraftJob: id });
      return;
    }
    const prompt = draftNotesUserPrompt(paper);
    const job = await repo.createJob(id, "draftNotes", prompt);
    set({ dialog: null, pendingDraftJob: null });
    await get().refresh();
    await runJob(job.id, id, DRAFT_NOTES_SYSTEM, prompt, async (raw) => {
      const notes = normalizeNotes(extractJson(raw));
      await repo.applyDraftedNotes(id, notes, true);
    });
  },

  cancelJob: async (jobId) => {
    const job = get().jobs.find((item) => item.id === jobId);
    if (job?.type === "mineruParse") {
      cancelMineruPaper(job.paperId);
      await repo.updateJob(jobId, {
        status: "cancelled",
        error: "cancelled",
        finishedAt: nowIso(),
      });
      await repo.setMineruState(job.paperId, { status: "cancelled" });
      await get().refresh();
      return;
    }
    abortMap.get(jobId)?.abort();
    abortMap.delete(jobId);
    await cancelChat(jobId);
    await repo.updateJob(jobId, {
      status: "cancelled",
      error: "cancelled",
      finishedAt: nowIso(),
    });
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
      if (usable) enqueueMineru(() => backfillMeta(mineruHost()));
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
    if (!guardUnsaved(get)) return;
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

function guardUnsaved(get: () => FieldState): boolean {
  if (!get().unsavedNote) return true;
  get().setFlash({ tone: "warn", text: "请先保存或取消正在编辑的笔记。" });
  return false;
}

function errText(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

async function jobStillRunning(jobId: string): Promise<boolean> {
  if (typeof repo.jobStatus !== "function") return true;
  return (await repo.jobStatus(jobId)) === "running";
}

async function dropUnreachableLinks(paperId: string): Promise<void> {
  const paper = await repo.getPaper(paperId);
  if (!paper) return;
  const patch: { codeUrl?: string | null; projectPage?: string | null } = {};
  if (paper.codeUrl && paper.fieldSources?.codeUrl !== "user" && (await verifyReachable(paper.codeUrl)) === "unreachable") {
    patch.codeUrl = null;
  }
  if (paper.projectPage && paper.fieldSources?.projectPage !== "user" && (await verifyReachable(paper.projectPage)) === "unreachable") {
    patch.projectPage = null;
  }
  if (Object.keys(patch).length) await repo.updatePaper(paperId, patch, false);
}

async function runJob(
  jobId: string,
  paperId: string,
  system: string,
  user: string,
  apply: (raw: string) => Promise<void>,
  quiet = false,
) {
  const controller = new AbortController();
  abortMap.set(jobId, controller);
  log.info("llm", `AI 作业开始（${jobId}）`);
  // 作业实况：请求模型 → 写入结果；quiet 即解析后的自动补全，面板标注「自动」。
  trackJob(jobId, paperId, "request", { auto: quiet });
  let outcome: JobOutcome = "error";
  const started = await repo.updateJob(jobId, { status: "running", startedAt: nowIso() });
  if (started === false) {
    outcome = "cancelled";
    return;
  }
  await useField.getState().refresh();
  try {
    const raw = await completeChat({
      jobId,
      system,
      user,
      signal: controller.signal,
    });
    if (controller.signal.aborted || (await jobStillRunning(jobId)) === false) {
      outcome = "cancelled";
      return;
    }
    trackJob(jobId, paperId, "apply");
    await apply(raw);
    if (await jobStillRunning(jobId) === false) {
      outcome = "cancelled";
      return;
    }
    const finished = await repo.updateJob(jobId, {
      status: "done",
      resultJson: raw,
      finishedAt: nowIso(),
    });
    if (finished === false) {
      outcome = "cancelled";
      return;
    }
    outcome = "done";
    log.info("llm", `AI 作业完成（${jobId}）`);
    if (!quiet) {
      useField.getState().setFlash({ tone: "ok", text: "AI 作业完成。阅读状态未改动。" });
    }
  } catch (err) {
    if (controller.signal.aborted || (await jobStillRunning(jobId)) === false) {
      outcome = "cancelled";
      return;
    }
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    log.error("llm", `AI 作业失败（${jobId}）`, message);
    const marked = await repo.updateJob(jobId, {
      status: "error",
      error: message,
      finishedAt: nowIso(),
    });
    if (marked === false) {
      outcome = "cancelled";
      return;
    }
    useField.getState().setFlash({ tone: "error", text: message });
  } finally {
    endJob(jobId, outcome);
    abortMap.delete(jobId);
    await useField.getState().refresh();
  }
}
