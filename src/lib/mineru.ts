import { invoke } from "@tauri-apps/api/core";
import type { MineruProviderKind } from "./types";
import { isTauri } from "./util";

export type { MineruProviderKind } from "./types";
export type MineruTier = "flash" | "basic" | "standard" | "advanced";
export type MineruModelVersion = "pipeline" | "vlm";
export type MineruLanguage = "ch" | "en";

/** v2 设置对外视图：token 永不回显，只返回 hasToken；configured 为派生只读字段。 */
export interface MineruSettingsV2 {
  version: 2;
  /** 回退顺序：提交时按此顺序取第一个可用的启用源。 */
  order: MineruProviderKind[];
  local: { enabled: boolean; socketPath: string };
  ssh: {
    enabled: boolean;
    host: string;
    port: number;
    user: string;
    identityFile: string;
    socketPath: string;
    inboxDir: string;
  };
  api: {
    hasToken: boolean;
    modelVersion: MineruModelVersion;
    language: MineruLanguage;
    enableFormula: boolean;
    enableTable: boolean;
  };
  tier: MineruTier;
  pageRange: string;
  configured: boolean;
}

/** 保存入参：与 v2 同构，但 api.token 三态——null=保留已存、""=清除、其他=写入。 */
export interface MineruSaveInput {
  order: MineruProviderKind[];
  local: { enabled: boolean; socketPath: string };
  ssh: {
    enabled: boolean;
    host: string;
    port: number;
    user: string;
    identityFile: string;
    socketPath: string;
    inboxDir: string;
  };
  api: {
    token: string | null;
    modelVersion: MineruModelVersion;
    language: MineruLanguage;
    enableFormula: boolean;
    enableTable: boolean;
  };
  tier: MineruTier;
  pageRange: string;
}

export interface MineruSubmitResult {
  /** 实际使用的来源："local" | "ssh" | "api"。 */
  provider: MineruProviderKind;
  /** 本地路径（local）/远程路径（ssh）；官方 API 为空串。 */
  remotePath: string;
  /** doclib short_id / 官方 API batch_id。 */
  shortId: string;
  /** doclib 数字 id 字符串化；官方 API 为空。 */
  parseIds: string[];
  status: string;
  /** doclib tier；官方 API 为 model_version。 */
  tier: string;
  /** 提交当时的凭据指纹。轮询必须原样带回。 */
  credFingerprint: string;
}

export interface MineruParsePoll {
  id: string;
  status: string;
  error: string | null;
  /** 进度「已解析页/总页数」（官方 API 提供；doclib 为 null）。 */
  progress: string | null;
}

export interface ProviderHealth {
  provider: MineruProviderKind;
  ok: boolean;
  latencyMs: number;
  message: string;
}

/** 浏览器预览的本地存储格式：与后端 mineru-settings.json v2 同构（token 明文只留在本机浏览器）。 */
interface BrowserMineruStore {
  version: 2;
  order: MineruProviderKind[];
  local: { enabled: boolean; socketPath: string };
  ssh: MineruSaveInput["ssh"];
  api: Omit<MineruSaveInput["api"], "token"> & { token: string };
  tier: MineruTier;
  pageRange: string;
}

const BROWSER_KEY = "paper-field.mineru";
const PROVIDER_ORDER: MineruProviderKind[] = ["local", "ssh", "api"];

export const DEFAULT_MINERU: MineruSettingsV2 = {
  version: 2,
  order: [...PROVIDER_ORDER],
  local: { enabled: false, socketPath: "~/.mineru/doclib.sock" },
  ssh: {
    enabled: false,
    host: "",
    port: 22,
    user: "",
    identityFile: "",
    socketPath: "~/.mineru/doclib.sock",
    inboxDir: "~/.mineru/paper-field-inbox",
  },
  api: {
    hasToken: false,
    modelVersion: "pipeline",
    language: "ch",
    enableFormula: true,
    enableTable: true,
  },
  tier: "standard",
  pageRange: "all",
  configured: false,
};

function asProvider(value: unknown): MineruProviderKind | null {
  return value === "local" || value === "ssh" || value === "api" ? value : null;
}

function normalizeOrder(value: unknown): MineruProviderKind[] {
  const raw: MineruProviderKind[] = Array.isArray(value)
    ? value.flatMap((item) => {
        const kind = asProvider(item);
        return kind ? [kind] : [];
      })
    : [];
  // 与 Rust 侧同义：过滤非法项、去重并按 local→ssh→api 补全缺失。
  const list = [...new Set(raw)];
  const seen = new Set(list);
  return [...list, ...PROVIDER_ORDER.filter((kind) => !seen.has(kind))];
}

function asTier(value: unknown): MineruTier {
  return value === "flash" || value === "basic" || value === "standard" || value === "advanced"
    ? value
    : "standard";
}

/** v1（mode/socketPath/sshHost/...）旧值 → v2：迁移规则与 Rust 侧一致。 */
function migrateV1(value: Record<string, unknown>): MineruSettingsV2 {
  const mode = value.mode;
  const socket = typeof value.socketPath === "string" && value.socketPath.trim()
    ? value.socketPath.trim()
    : DEFAULT_MINERU.local.socketPath;
  const next: MineruSettingsV2 = {
    ...DEFAULT_MINERU,
    local: { enabled: mode === "local", socketPath: socket },
    ssh: {
      enabled: mode === "ssh",
      host: typeof value.sshHost === "string" ? value.sshHost.trim() : "",
      port: Number(value.sshPort) || 22,
      user: typeof value.sshUser === "string" ? value.sshUser.trim() : "",
      identityFile: typeof value.identityFile === "string" ? value.identityFile.trim() : "",
      socketPath: socket,
      inboxDir:
        typeof value.remoteInbox === "string" && value.remoteInbox.trim()
          ? value.remoteInbox.trim()
          : DEFAULT_MINERU.ssh.inboxDir,
    },
    tier: asTier(value.tier),
    pageRange: typeof value.pageRange === "string" && value.pageRange.trim() ? value.pageRange.trim() : "all",
  };
  const enabled: MineruProviderKind[] = [];
  if (next.local.enabled) enabled.push("local");
  if (next.ssh.enabled) enabled.push("ssh");
  next.order = [
    ...enabled,
    ...PROVIDER_ORDER.filter((kind) => !enabled.includes(kind)),
  ];
  return withDerived(next);
}

function withDerived(settings: Omit<MineruSettingsV2, "configured">): MineruSettingsV2 {
  return { ...settings, configured: enabledSources(settings).length > 0 };
}

/** 启用源判定：local/ssh 看 enabled，api 看 token 是否已保存。 */
export function enabledSources(settings: Pick<MineruSettingsV2, "local" | "ssh" | "api">): MineruProviderKind[] {
  const list: MineruProviderKind[] = [];
  if (settings.local.enabled) list.push("local");
  if (settings.ssh.enabled) list.push("ssh");
  if (settings.api.hasToken) list.push("api");
  return list;
}

/** 同时兼容 v1 localStorage 旧值、后端 MineruPublic v2 与浏览器 v2 镜像。 */
function normalize(value: unknown): MineruSettingsV2 {
  if (!value || typeof value !== "object") return DEFAULT_MINERU;
  const raw = value as Record<string, unknown>;
  if (typeof raw.mode === "string") return migrateV1(raw);
  const local = (raw.local ?? {}) as Record<string, unknown>;
  const ssh = (raw.ssh ?? {}) as Record<string, unknown>;
  const api = (raw.api ?? {}) as Record<string, unknown>;
  const hasToken = api.hasToken === true || (typeof api.token === "string" && Boolean(api.token.trim()));
  const settings: Omit<MineruSettingsV2, "configured"> = {
    version: 2,
    order: normalizeOrder(raw.order),
    local: {
      enabled: local.enabled === true,
      socketPath:
        typeof local.socketPath === "string" && local.socketPath.trim()
          ? local.socketPath.trim()
          : DEFAULT_MINERU.local.socketPath,
    },
    ssh: {
      enabled: ssh.enabled === true,
      host: typeof ssh.host === "string" ? ssh.host.trim() : "",
      port: Number(ssh.port) || 22,
      user: typeof ssh.user === "string" ? ssh.user.trim() : "",
      identityFile: typeof ssh.identityFile === "string" ? ssh.identityFile.trim() : "",
      socketPath:
        typeof ssh.socketPath === "string" && ssh.socketPath.trim()
          ? ssh.socketPath.trim()
          : DEFAULT_MINERU.ssh.socketPath,
      inboxDir:
        typeof ssh.inboxDir === "string" && ssh.inboxDir.trim()
          ? ssh.inboxDir.trim()
          : DEFAULT_MINERU.ssh.inboxDir,
    },
    api: {
      hasToken,
      modelVersion: api.modelVersion === "vlm" ? "vlm" : "pipeline",
      language: api.language === "en" ? "en" : "ch",
      enableFormula: api.enableFormula !== false,
      enableTable: api.enableTable !== false,
    },
    tier: asTier(raw.tier),
    pageRange:
      typeof raw.pageRange === "string" && raw.pageRange.trim() ? raw.pageRange.trim() : "all",
  };
  return withDerived(settings);
}

function readBrowserStore(): MineruSettingsV2 {
  try {
    const raw = localStorage.getItem(BROWSER_KEY);
    return raw ? normalize(JSON.parse(raw)) : DEFAULT_MINERU;
  } catch {
    return DEFAULT_MINERU;
  }
}

export async function loadMineruSettings(): Promise<MineruSettingsV2> {
  if (!isTauri()) return readBrowserStore();
  return normalize(await invoke<Record<string, unknown>>("mineru_settings"));
}

export async function saveMineruSettings(input: MineruSaveInput): Promise<MineruSettingsV2> {
  if (!isTauri()) {
    // 浏览器分支按三态合并本机 token：null=保留、""=清除、其他=写入。
    const prevToken = localStorage.getItem(`${BROWSER_KEY}.token`) ?? "";
    const token = input.api.token === null || input.api.token === undefined ? prevToken : input.api.token;
    if (token) localStorage.setItem(`${BROWSER_KEY}.token`, token);
    else localStorage.removeItem(`${BROWSER_KEY}.token`);
    const store: BrowserMineruStore = {
      version: 2,
      order: normalizeOrder(input.order),
      local: input.local,
      ssh: input.ssh,
      api: {
        token,
        modelVersion: input.api.modelVersion,
        language: input.api.language,
        enableFormula: input.api.enableFormula,
        enableTable: input.api.enableTable,
      },
      tier: input.tier,
      pageRange: input.pageRange,
    };
    localStorage.setItem(BROWSER_KEY, JSON.stringify(store));
    return normalize(store);
  }
  return normalize(await invoke<Record<string, unknown>>("save_mineru_settings", { settings: input }));
}

/** 单源测试连接（读已保存的磁盘配置），返回中文结果。 */
export async function testMineru(provider: MineruProviderKind): Promise<string> {
  if (!isTauri()) throw new Error("浏览器预览无法连接 MinerU，请使用桌面应用。");
  return invoke<string>("mineru_test", { provider });
}

/** 并行探测全部启用源；浏览器预览直接返回空数组，不抛错（init 容错约定）。 */
export async function mineruProbe(): Promise<ProviderHealth[]> {
  if (!isTauri()) return [];
  try {
    const rows = await invoke<Array<Record<string, unknown>>>("mineru_probe");
    return rows.map((row) => ({
      provider: (asProvider(row.provider) ?? "local") as MineruProviderKind,
      ok: row.ok === true,
      latencyMs: Number(row.latencyMs) || 0,
      message: typeof row.message === "string" ? row.message : "",
    }));
  } catch {
    return [];
  }
}

export async function listPdfs(directory: string): Promise<string[]> {
  if (!isTauri()) throw new Error("请在桌面应用中选择目录。");
  return invoke<string[]>("list_pdfs", { directory });
}

export async function normalizePdf(path: string): Promise<string> {
  if (!isTauri()) throw new Error("请在桌面应用中选择 PDF。");
  return invoke<string>("normalize_pdf", { path });
}

export async function openLocalPdf(path: string): Promise<void> {
  if (!isTauri()) throw new Error("请在桌面应用中打开本地 PDF。");
  await invoke("open_pdf", { path });
}

/** provider 省略 = 后端按 order 自动 fallback；提交成功即在 SubmitResult 里返回实际来源。 */
export async function mineruSubmit(
  paperId: string,
  localPath: string,
  force: boolean,
  provider?: MineruProviderKind,
): Promise<MineruSubmitResult> {
  return invoke<MineruSubmitResult>("mineru_submit", {
    paperId,
    localPath,
    force,
    provider: provider ?? null,
  });
}

export async function mineruCurrentFingerprint(provider: MineruProviderKind): Promise<string> {
  return invoke<string>("mineru_current_fingerprint", { provider });
}

/** 恢复/轮询仅同源：provider 必填，不做自动回退（doclib short_id 与 API batch_id 命名空间不同）。 */
export async function mineruParseStatuses(
  provider: MineruProviderKind,
  docRef: string,
  parseIds: string[],
  paperId: string,
  expectedFingerprint: string,
): Promise<MineruParsePoll[]> {
  return invoke<MineruParsePoll[]>("mineru_parse_statuses", {
    provider,
    docRef,
    parseIds,
    paperId,
    expectedFingerprint,
  });
}

export async function mineruMarkdown(
  provider: MineruProviderKind,
  docRef: string,
  tier: string,
  pageRange: string,
  paperId: string,
  expectedFingerprint: string,
): Promise<string> {
  return invoke<string>("mineru_markdown", {
    provider,
    docRef,
    tier,
    pageRange,
    paperId,
    expectedFingerprint,
  });
}
