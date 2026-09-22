import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./util";

export type MineruMode = "off" | "local" | "ssh";
export type MineruTier = "flash" | "basic" | "standard" | "advanced";

export interface MineruSettings {
  mode: MineruMode;
  socketPath: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  identityFile: string;
  remoteInbox: string;
  tier: MineruTier;
  pageRange: string;
  configured: boolean;
}

export interface MineruSubmitResult {
  remotePath: string;
  shortId: string;
  parseIds: number[];
  status: string;
  tier: string;
}

export interface MineruParsePoll {
  id: number;
  status: string;
  error: string | null;
}

const BROWSER_KEY = "paper-field.mineru";

export const DEFAULT_MINERU: MineruSettings = {
  mode: "off",
  socketPath: "~/.mineru/doclib.sock",
  sshHost: "",
  sshPort: 22,
  sshUser: "",
  identityFile: "",
  remoteInbox: "~/.mineru/paper-field-inbox",
  tier: "standard",
  pageRange: "all",
  configured: false,
};

function normalize(value: Partial<MineruSettings> | null | undefined): MineruSettings {
  const mode = value?.mode === "local" || value?.mode === "ssh" ? value.mode : "off";
  const tier =
    value?.tier === "flash" || value?.tier === "basic" || value?.tier === "standard" || value?.tier === "advanced"
      ? value.tier
      : "standard";
  const settings: MineruSettings = {
    mode,
    socketPath: value?.socketPath?.trim() || DEFAULT_MINERU.socketPath,
    sshHost: value?.sshHost?.trim() ?? "",
    sshPort: value?.sshPort || 22,
    sshUser: value?.sshUser?.trim() ?? "",
    identityFile: value?.identityFile?.trim() ?? "",
    remoteInbox: value?.remoteInbox?.trim() || DEFAULT_MINERU.remoteInbox,
    tier,
    pageRange: value?.pageRange?.trim() || "all",
    configured: false,
  };
  settings.configured =
    mode === "local" || (mode === "ssh" && Boolean(settings.sshHost) && Boolean(settings.sshUser));
  return settings;
}

export async function loadMineruSettings(): Promise<MineruSettings> {
  if (!isTauri()) {
    try {
      const raw = localStorage.getItem(BROWSER_KEY);
      return normalize(raw ? (JSON.parse(raw) as Partial<MineruSettings>) : null);
    } catch {
      return DEFAULT_MINERU;
    }
  }
  return normalize(await invoke<MineruSettings>("mineru_settings"));
}

export async function saveMineruSettings(input: MineruSettings): Promise<MineruSettings> {
  const next = normalize(input);
  if (!isTauri()) {
    localStorage.setItem(BROWSER_KEY, JSON.stringify(next));
    return { ...next, configured: false };
  }
  return normalize(await invoke<MineruSettings>("save_mineru_settings", { settings: next }));
}

export async function testMineru(input: MineruSettings): Promise<string> {
  if (!isTauri()) throw new Error("浏览器预览无法连接 MinerU，请使用桌面应用。");
  return invoke<string>("mineru_test", { settings: normalize(input) });
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

export async function mineruSubmit(
  settings: MineruSettings,
  localPath: string,
  paperId: string,
  force: boolean,
): Promise<MineruSubmitResult> {
  return invoke<MineruSubmitResult>("mineru_submit", {
    settings,
    localPath,
    paperId,
    force,
  });
}

export async function mineruParseStatuses(settings: MineruSettings, parseIds: number[]): Promise<MineruParsePoll[]> {
  return invoke<MineruParsePoll[]>("mineru_parse_statuses", { settings, parseIds });
}

export async function mineruMarkdown(
  settings: MineruSettings,
  docRef: string,
  tier: string,
  pageRange: string,
): Promise<string> {
  return invoke<string>("mineru_markdown", { settings, docRef, tier, pageRange });
}
