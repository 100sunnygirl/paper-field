import { resetEngine } from "./engine";
import { isTauri } from "./util";

export async function backupLibrary(): Promise<string | null> {
  if (!isTauri()) throw new Error("DESKTOP_ONLY");
  const { invoke } = await import("@tauri-apps/api/core");
  const { getEngine } = await import("./engine");
  const engine = await getEngine();
  await engine.execute("PRAGMA wal_checkpoint(FULL)");
  // 保存对话框由 Rust 侧弹出：命令只写用户在系统对话框里选的位置。取消时返回 null。
  return invoke<string | null>("create_library_backup");
}

/** Mirrors Rust `restore::BackupSummary`. */
export interface BackupSummary {
  papers: number;
  latestUpdatedAt: string | null;
  pdfs: number;
  zipBytes: number;
  /** Restored LLM/MinerU network settings that were switched off; null when none. */
  settingsNotice?: string | null;
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- 上次备份记录（本机 localStorage，浏览器与桌面共用） ----------

/** 超过该天数未备份时，备份卡给出过期提醒。 */
export const BACKUP_STALE_DAYS = 7;

/** 上次成功备份的本机记录：时间、位置与当时的规模，用于状态显示与定期提醒。 */
export interface BackupRecord {
  /** epoch 毫秒。 */
  at: number;
  /** 保存位置（桌面目录路径或浏览器下载文件名）。 */
  where: string;
  papers: number;
  pdfs: number | null;
}

const BACKUP_RECORD_KEY = "paper-field.last-backup";

export function readLastBackup(): BackupRecord | null {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(BACKUP_RECORD_KEY);
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    if (
      value &&
      typeof value === "object" &&
      typeof (value as BackupRecord).at === "number" &&
      typeof (value as BackupRecord).where === "string"
    ) {
      return value as BackupRecord;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeLastBackup(record: BackupRecord): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(BACKUP_RECORD_KEY, JSON.stringify(record));
  } catch {
    // 隐私模式等写不进：状态显示降级为「未记录」，不影响备份本身。
  }
}

/** 距上次备份的整天数（不足一天按 0）。 */
export function daysSinceBackup(at: number, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - at) / 86400000));
}

/** Confirm-dialog body; `current` is null when the live count could not be read. */
export function restoreConfirmText(backup: BackupSummary, current: number | null): string {
  const lines = [
    `备份：${backup.papers} 篇文献，${backup.pdfs} 个 PDF，${formatBytes(backup.zipBytes)}`,
    `备份中最近更新：${backup.latestUpdatedAt ?? "未知"}`,
    `当前文库：${current === null ? "未知" : `${current} 篇文献`}`,
    ...(current !== null && backup.papers < current
      ? ["", `⚠ 备份比当前少 ${current - backup.papers} 篇，恢复后这些论文会丢失。`]
      : []),
    ...(backup.settingsNotice ? ["", backup.settingsNotice] : []),
    "",
    "恢复会用备份替换当前文库，原文件会移到 pre-restore 目录。确定后应用将重启。",
  ];
  return lines.join("\n");
}

async function currentPaperCount(): Promise<number | null> {
  try {
    const { getEngine } = await import("./engine");
    const rows = await (await getEngine()).select<{ n: number }>("SELECT count(*) AS n FROM papers");
    return Number(rows[0]?.n ?? 0);
  } catch {
    return null;
  }
}

export async function restoreLibrary(): Promise<boolean> {
  if (!isTauri()) throw new Error("DESKTOP_ONLY");
  const { ask } = await import("@tauri-apps/plugin-dialog");
  const { invoke } = await import("@tauri-apps/api/core");
  // 打开对话框由 Rust 侧弹出；只暂存备份，文件在下次启动、数据库打开之前才替换。取消时返回 null。
  const summary = await invoke<BackupSummary | null>("restore_library_backup");
  if (!summary) return false;
  const confirmed = await ask(restoreConfirmText(summary, await currentPaperCount()), {
    title: "确认恢复文库",
    kind: "warning",
    okLabel: "恢复并重启",
    cancelLabel: "取消",
  });
  if (!confirmed) {
    // Drop the staged copy and marker; live files were never touched.
    await invoke("restore_abandon");
    return false;
  }
  // Until this flips the marker to staged, a quit or crash discards the restore.
  await invoke("restore_commit_preview");
  await resetEngine();
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
  return true;
}
