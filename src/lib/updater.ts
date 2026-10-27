import { isTauri } from "./util";

/** True until the pubkey in tauri.conf.json is replaced with a real minisign public key. */
export function updaterPubkeyIsPlaceholder(pubkey: string): boolean {
  const value = pubkey.trim();
  if (!value || value.includes("PLACEHOLDER")) return true;
  try {
    return atob(value).includes("PLACEHOLDER");
  } catch {
    return true;
  }
}

export function configuredUpdaterIsPlaceholder(): boolean {
  return updaterPubkeyIsPlaceholder(__PF_UPDATER_PUBKEY__);
}

const PLACEHOLDER_MESSAGE =
  "尚未配置更新签名公钥，暂时无法检查更新。请按说明生成密钥并重新打包后再试。";

/** 一次检查更新的结构化结果：先预览版本与说明，下载与重启由用户决定。 */
export interface AppUpdateInfo {
  status: "latest" | "available" | "error" | "unavailable" | "placeholder";
  message: string;
  /** available 时的版本号 / 发布日期 / 发行说明。 */
  version?: string;
  date?: string;
  notes?: string;
  /** 待安装的更新句柄（仅桌面端 available 时存在，不序列化）。 */
  update?: unknown;
}

/** 检查 GitHub Releases，只读不装。占位公钥不联网。 */
export async function checkAppUpdateInfo(): Promise<AppUpdateInfo> {
  if (configuredUpdaterIsPlaceholder()) return { status: "placeholder", message: PLACEHOLDER_MESSAGE };
  if (!isTauri()) return { status: "unavailable", message: "检查更新只在桌面应用里可用。" };
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return { status: "latest", message: "已是最新版本。" };
    return {
      status: "available",
      message: `发现新版本 ${update.version}。`,
      version: update.version,
      date: update.date ?? undefined,
      notes: typeof update.body === "string" ? update.body : undefined,
      update,
    };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `检查更新失败：${text}` };
  }
}

/** 下载并安装「检查更新」拿到的更新包，装完后重启。 */
export async function installAppUpdate(info: AppUpdateInfo): Promise<string> {
  const update = info.update as { downloadAndInstall: () => Promise<void> } | undefined;
  if (!update) throw new Error("尚未检查到可安装的更新，请先点「检查更新」。");
  await update.downloadAndInstall();
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
  return `正在安装 ${info.version ?? "新版本"} 并重新打开。`;
}
