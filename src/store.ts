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
import { backfillMeta, cancelMineruPaper, clearMineruCancel, enqueueMineru, resumeMineru, runMineruBatch } from "./lib/mineruRun";
import { pickProviderFromHealths, providerLabel, summarizeHealths } from "./lib/mineruPlan";
import { DRAFT_NOTES_SYSTEM, PREPARE_META_SYSTEM, draftNotesUserPrompt, normalizeMeta, normalizeNotes, prepareMetaUserPrompt } from "./lib/prompts";
import { repo } from "./lib/repo";
import { cancelChat, completeChat, loadSettings, saveSettings } from "./lib/settings";
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
  flash: Flash | null;
  mode: AppMode;
  domains: Domain[];
  selectedDomainId: string | null;
  papers: PaperListItem[];
  selectedPaperId: string | null;
  paper: PaperDetail | null;
  archive: PaperListItem[];
  intake: PaperListItem[];
  jobs: LlmJob[];
  stats: FieldStats;
  search: string;
  archiveFilter: OpenSource | "all";
  settings: LlmSettings;
  mineru: MineruSettingsV2;
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
    | "pick-domain"
    | "edit-paper"
    | null;
  pendingDraftJob: string | null;
  unsavedNote: boolean;
  loadError: string | null;
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
  savePaperPatch: (patch: Parameters<typeof repo.updatePaper>[1]) => Promise<void>;
  saveAuthors: (authors: PaperDetail["authors"]) => Promise<void>;
  saveNote: (kind: NoteKind, content: string) => Promise<void>;
  markRead: () => Promise<void>;
  markReading: () => Promise<void>;
  markUnread: () => Promise<void>;
  setReadingStatus: (status: "unread" | "reading" | "read") => Promise<void>;
  movePaper: (domainId: string) => Promise<void>;
  deletePaper: () => Promise<void>;
  setUnsavedNote: (value: boolean) => void;
  runPrepareMeta: (paperId?: string, overwrite?: boolean, quiet?: boolean) => Promise<void>;
  runDraftNotes: (paperId?: string, overwrite?: boolean) => Promise<void>;
  cancelJob: (jobId: string) => Promise<void>;
  saveLlmSettings: (input: { baseUrl: string; model: string; apiKey?: string }) => Promise<void>;
  saveMineruSettings: (input: MineruSaveInput) => Promise<void>;
  probeMineru: () => Promise<ProviderHealth[]>;
  exportCurrentDomain: () => Promise<void>;
  navigatePapers: (delta: number) => Promise<void>;
  setFlash: (flash: Flash | null) => void;
}

function currentList(state: FieldState): PaperListItem[] {
  if (state.mode === "archive") return state.archive;
  if (state.mode === "intake") return state.intake;
  return state.papers;
}

export const useField = create<FieldState>((set, get) => ({
  ready: false,
  error: null,
  flash: null,
  mode: "field",
  domains: [],
  selectedDomainId: null,
  papers: [],
  selectedPaperId: null,
  paper: null,
  archive: [],
  intake: [],
  jobs: [],
  stats: { read: 0, total: 0, openSource: 0, queued: 0, running: 0 },
  search: "",
  archiveFilter: "all",
  settings: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", hasKey: false },
  mineru: DEFAULT_MINERU,
  mineruHealth: [],
  effectiveProvider: null,
  dialog: null,
  pendingDraftJob: null,
  unsavedNote: false,
  loadError: null,

  setFlash: (flash) => set({ flash }),
  setUnsavedNote: (value) => set({ unsavedNote: value }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null, pendingDraftJob: null }),

  init: async () => {
    try {
      await repo.init();
      const [domains, settings, mineru] = await Promise.all([
        repo.listDomains(),
        loadSettings(),
        loadMineruSettings().catch(() => DEFAULT_MINERU),
      ]);
      const selectedDomainId = domains[0]?.id ?? null;
      set({ domains, selectedDomainId, settings, mineru, ready: true, error: null });
      await get().refresh();
      // 探测不阻断 ready：浏览器预览直接返回 []，桌面端最多 10s，完成后异步更新状态条。
      void get().probeMineru();
      enqueueMineru(() => resumeMineru(mineruHost()));
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        ready: true,
      });
    }
  },

  refresh: async () => {
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
    set({ stats, jobs, domains, papers, archive, intake, selectedPaperId, paper });
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

  setSearch: async (value) => {
    set({ search: value });
    await get().refresh();
  },

  setArchiveFilter: async (value) => {
    set({ archiveFilter: value });
    await get().refresh();
  },

  createDomain: async (input) => {
    if (!input.name.trim() || !input.code.trim()) {
      throw new Error("领域名称与短码必填");
    }
    const domain = await repo.createDomain(input);
    set({ dialog: null, selectedDomainId: domain.id, mode: "field" });
    await get().refresh();
  },

  updateDomain: async (input) => {
    const id = get().selectedDomainId;
    if (!id) return;
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
    if (!domainId) throw new Error("先选择一个领域");
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
          text: `已导入 ${created.length} 篇${skippedText}。当前没有可用的 MinerU 解析源，论文已入库但未解析，可到系统页配置。`,
        });
        return;
      }
      if (!failed.length) {
        get().setFlash({
          tone: "ok",
          text: `已导入 ${created.length} 篇${skippedText}，正在用${providerLabel(effective)}解析。`,
        });
      }
      enqueueMineru(() => runMineruBatch(mineruHost(), created, false));
    } catch (err) {
      get().setFlash({ tone: "error", text: `导入失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  createManualPaper: async (input) => {
    const domainId = get().selectedDomainId;
    if (!domainId) throw new Error("先选择一个领域");
    const title = input.title.trim();
    if (!title) throw new Error("标题必填");
    try {
      const paper = await repo.createPaper({ domainId, title, pdfPath: input.pdfPath });
      const patch: { arxivId?: string; doi?: string } = {};
      if (input.arxivId?.trim()) patch.arxivId = input.arxivId.trim();
      if (input.doi?.trim()) patch.doi = input.doi.trim();
      if (Object.keys(patch).length) await repo.updatePaper(paper.id, patch);
      set({ dialog: null, selectedPaperId: paper.id, mode: "field" });
      await get().refresh();
      get().setFlash({
        tone: "ok",
        text: paper.pdfPath ? `已创建「${title}」，正在安排解析。` : `已创建「${title}」。`,
      });
      if (paper.pdfPath) enqueueMineru(() => runMineruBatch(mineruHost(), [paper.id], false));
    } catch (err) {
      get().setFlash({ tone: "error", text: `创建论文失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  retryMineru: async (paperId) => {
    if (!get().mineru.configured) {
      get().setFlash({ tone: "warn", text: "尚未启用任何 MinerU 解析源。可在系统页配置本地 / SSH / 官方 API。" });
      return;
    }
    // 探测结果可能过期：无生效源时先重探一次再下结论。
    if (!get().effectiveProvider) await get().probeMineru();
    if (!get().effectiveProvider) {
      const detail = summarizeHealths(get().mineru.order, get().mineruHealth);
      get().setFlash({
        tone: "warn",
        text: detail
          ? `当前没有可用的 MinerU 解析源（${detail}）。可到系统页查看失败原因。`
          : "当前没有可用的 MinerU 解析源（本地/SSH/官方 API 均未通过探测），可到系统页配置或查看失败原因。",
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
      enqueueMineru(() => runMineruBatch(mineruHost(), [paperId], true));
    } catch (err) {
      get().setFlash({ tone: "error", text: `重新解析失败：${errText(err)}，数据未改动。` });
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

  runPrepareMeta: async (paperId, overwrite = true, quiet = false) => {
    const id = paperId ?? get().selectedPaperId;
    if (!id) return;
    if (!get().settings.hasKey) {
      if (!quiet) {
        get().setFlash({ tone: "warn", text: "尚未配置 AI 服务。可在系统页写入，或继续手动录入。" });
      }
      return;
    }
    const paper = await repo.getPaper(id);
    if (!paper) return;
    const prompt = prepareMetaUserPrompt(paper);
    const job = await repo.createJob(id, "prepareMeta", prompt);
    await get().refresh();
    await runJob(job.id, PREPARE_META_SYSTEM, prompt, async (raw) => {
      const meta = normalizeMeta(extractJson(raw), paper.title);
      await repo.applyPreparedMeta(id, meta, overwrite);
    }, quiet);
  },

  runDraftNotes: async (paperId, overwrite = false) => {
    const id = paperId ?? get().selectedPaperId;
    if (!id) return;
    if (!get().settings.hasKey) {
      get().setFlash({ tone: "warn", text: "尚未配置 AI 服务，无法起草阅读笔记。" });
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
    await runJob(job.id, DRAFT_NOTES_SYSTEM, prompt, async (raw) => {
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
      get().setFlash({
        tone: settings.hasKey ? "ok" : "warn",
        text: settings.hasKey ? "AI 服务设置已保存。" : "已保存端点，但尚未写入 Key。",
      });
      if (settings.hasKey) enqueueMineru(() => backfillMeta(mineruHost()));
    } catch (err) {
      get().setFlash({ tone: "error", text: `保存 AI 服务设置失败：${errText(err)}，数据未改动。` });
      throw err;
    }
  },

  saveMineruSettings: async (input) => {
    try {
      const mineru = await saveMineruSettings(input);
      set({ mineru });
      get().setFlash({
        tone: mineru.configured ? "ok" : "warn",
        text: mineru.configured ? "MinerU 设置已保存，正在重新探测各来源。" : "已保存，尚未启用任何解析源。",
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

function mineruHost() {
  return {
    mineru: () => useField.getState().mineru,
    hasKey: () => useField.getState().settings.hasKey,
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
  return err instanceof Error ? err.message : String(err);
}

async function runJob(
  jobId: string,
  system: string,
  user: string,
  apply: (raw: string) => Promise<void>,
  quiet = false,
) {
  const controller = new AbortController();
  abortMap.set(jobId, controller);
  await repo.updateJob(jobId, { status: "running", startedAt: nowIso() });
  await useField.getState().refresh();
  try {
    const raw = await completeChat({
      jobId,
      system,
      user,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    await apply(raw);
    await repo.updateJob(jobId, {
      status: "done",
      resultJson: raw,
      finishedAt: nowIso(),
    });
    if (!quiet) {
      useField.getState().setFlash({ tone: "ok", text: "AI 作业完成。阅读状态未改动。" });
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    await repo.updateJob(jobId, {
      status: "error",
      error: message,
      finishedAt: nowIso(),
    });
    useField.getState().setFlash({ tone: "error", text: message });
  } finally {
    abortMap.delete(jobId);
    await useField.getState().refresh();
  }
}
