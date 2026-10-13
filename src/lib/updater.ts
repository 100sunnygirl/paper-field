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

/** Check GitHub Releases. A placeholder pubkey never contacts the network. */
export async function checkForAppUpdate(): Promise<string> {
  if (configuredUpdaterIsPlaceholder()) return PLACEHOLDER_MESSAGE;
  if (!isTauri()) return "检查更新只在桌面应用里可用。";
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return "已是最新版本。";
    await update.downloadAndInstall();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
    return `正在安装 ${update.version} 并重新打开。`;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return `检查更新失败：${text}`;
  }
}
