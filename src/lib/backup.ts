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
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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
