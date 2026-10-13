import { resetEngine } from "./engine";
import { isTauri } from "./util";

export async function backupLibrary(): Promise<string | null> {
  if (!isTauri()) throw new Error("DESKTOP_ONLY");
  const { save } = await import("@tauri-apps/plugin-dialog");
  const { invoke } = await import("@tauri-apps/api/core");
  const dest = await save({
    title: "备份文库",
    defaultPath: "paper-field-backup.zip",
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  if (!dest) return null;
  const { getEngine } = await import("./engine");
  const engine = await getEngine();
  await engine.execute("PRAGMA wal_checkpoint(FULL)");
  await invoke("create_library_backup", { dest });
  return dest;
}

export async function restoreLibrary(): Promise<boolean> {
  if (!isTauri()) throw new Error("DESKTOP_ONLY");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const { invoke } = await import("@tauri-apps/api/core");
  const picked = await open({
    title: "恢复文库",
    multiple: false,
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  if (!picked || Array.isArray(picked)) return false;
  // Only stages the backup; files are swapped on next launch before the database opens.
  await invoke("restore_library_backup", { src: picked });
  await resetEngine();
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
  return true;
}
