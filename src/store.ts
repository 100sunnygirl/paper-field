import { create } from "zustand";
import { exportDomain } from "./lib/export";
import { DEFAULT_MINERU, loadMineruSettings, saveMineruSettings, type MineruSettings } from "./lib/mineru";
import { backfillMeta, cancelMineruPaper, clearMineruCancel, enqueueMineru, resumeMineru, runMineruBatch } from "./lib/mineruRun";
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
  mineru: MineruSettings;
  dialog:
    | "paper"
    | "domain"
    | "confirm-notes"
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
  importPdfs: (paths: string[]) => Promise<void>;
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
  saveMineruSettings: (input: MineruSettings) => Promise<void>;
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
    const intake = await repo.listIntake();
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
    set({ selectedDomainId: id, selectedPaperId: null, paper: null, mode: "field", dialog: null });
    await get().refresh();
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
    await repo.deleteDomain(id);
    const domains = await repo.listDomains();
    set({ selectedDomainId: domains[0]?.id ?? null, dialog: null, selectedPaperId: null, paper: null });
    await get().refresh();
  },

  importPdfs: async (paths) => {
    const domainId = get().selectedDomainId;
    if (!domainId) throw new Error("先选择一个领域");
    const unique = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
    if (!unique.length) throw new Error("请选择至少一个 PDF");
    const { created, skipped } = await repo.importLocalPdfs(domainId, unique);
    set({
      dialog: null,
      selectedPaperId: created[0]?.id ?? get().selectedPaperId,
      mode: "field",
    });
    await get().refresh();
    if (!created.length) {
      get().setFlash({ tone: "warn", text: "这些 PDF 已在库中。" });
      return;
    }
    const skippedText = skipped.length ? `，跳过 ${skipped.length} 篇已在库中` : "";
    if (!get().mineru.configured) {
      get().setFlash({
        tone: "warn",
        text: `已导入 ${created.length} 篇${skippedText}。MinerU 未配置，论文已入库，尚未解析。`,
      });
      return;
    }
    get().setFlash({
      tone: "ok",
      text: `已导入 ${created.length} 篇${skippedText}。已将 ${created.length} 篇论文发送到 MinerU 4.0 解析。`,
    });
    const ids = created.map((paper) => paper.id);
    enqueueMineru(() => runMineruBatch(mineruHost(), ids, false));
  },

  retryMineru: async (paperId) => {
    if (!get().mineru.configured) {
      get().setFlash({ tone: "warn", text: "尚未配置 MinerU。可在系统页写入连接方式。" });
      return;
    }
    clearMineruCancel(paperId);
    await repo.setMineruState(paperId, {
      status: "queued",
      error: null,
      parseId: null,
      parseIds: [],
      docRef: null,
    });
    await get().refresh();
    get().setFlash({ tone: "ok", text: "已将这篇论文发送到 MinerU 4.0 解析。" });
    enqueueMineru(() => runMineruBatch(mineruHost(), [paperId], true));
  },

  savePaperPatch: async (patch) => {
    const id = get().selectedPaperId;
    if (!id) return;
    await repo.updatePaper(id, patch, true);
    await get().refresh();
  },

  saveAuthors: async (authors) => {
    const id = get().selectedPaperId;
    if (!id) return;
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
    await repo.setReadingStatus(id, status);
    await get().refresh();
    const labels = { unread: "未读", reading: "在读", read: "已读" };
    get().setFlash({ tone: "ok", text: `阅读状态已更新为${labels[status]}。` });
  },

  movePaper: async (domainId) => {
    const id = get().selectedPaperId;
    if (!id) return;
    await repo.updatePaper(id, { domainId });
    set({ dialog: null, selectedDomainId: domainId, mode: "field" });
    await get().refresh();
    const domain = get().domains.find((d) => d.id === domainId);
    get().setFlash({
      tone: "ok",
      text: domain ? `论文已移动到「${domain.name}」。` : "论文已移动到新领域。",
    });
  },

  deletePaper: async () => {
    const id = get().selectedPaperId;
    if (!id) return;
    await repo.deletePaper(id);
    set({ selectedPaperId: null, paper: null, dialog: null, unsavedNote: false });
    await get().refresh();
    get().setFlash({ tone: "ok", text: "论文已删除。" });
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
    await saveSettings(input);
    const settings = await loadSettings();
    set({ settings });
    get().setFlash({
      tone: settings.hasKey ? "ok" : "warn",
      text: settings.hasKey ? "AI 服务设置已保存。" : "已保存端点，但尚未写入 Key。",
    });
    if (settings.hasKey) enqueueMineru(() => backfillMeta(mineruHost()));
  },

  saveMineruSettings: async (input) => {
    const mineru = await saveMineruSettings(input);
    set({ mineru });
    get().setFlash({
      tone: mineru.configured ? "ok" : "warn",
      text: mineru.configured ? "MinerU 设置已保存。" : "已保存，MinerU 仍未配置完成。",
    });
    if (mineru.configured) enqueueMineru(() => resumeMineru(mineruHost()));
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
    const index = Math.max(0, list.findIndex((p) => p.id === get().selectedPaperId));
    const next = list[Math.min(list.length - 1, Math.max(0, index + delta))];
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
