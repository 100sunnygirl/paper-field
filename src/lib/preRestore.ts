import { formatBytes } from "./backup";

/** One restorable copy or sidecar directory kept from a past restore. */
export interface PreDir {
  name: string;
  path: string;
  createdMs: number;
  bytes: number;
  hasDb: boolean;
  /** Stray WAL/SHM files moved aside during rollback, not a library copy. */
  orphans: boolean;
}

export interface PreList {
  dirs: PreDir[];
  /** A restore marker exists; deletion is refused until it is handled. */
  busy: boolean;
}

export async function listPreDirs(): Promise<PreList> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<PreList>("restore_list_pre");
}

export function deleteConfirmText(dir: PreDir, all: PreDir[]): string {
  const kind = dir.orphans ? "恢复时移开的临时文件" : "原数据副本";
  const lines = [`删除${kind} ${dir.name}（${formatBytes(dir.bytes)}）？`];
  if (dir.orphans) lines.push("一般可以安全删除；需要排查数据问题时请先保留。");
  if (dir.hasDb && all.filter((d) => d.hasDb).length === 1) {
    lines.push("这是唯一一份可回滚的原数据。");
  }
  lines.push("此操作不可撤销。");
  return lines.join("\n");
}

/** Returns true when the folder was deleted. */
export async function deletePreDir(dir: PreDir, all: PreDir[]): Promise<boolean> {
  const { ask } = await import("@tauri-apps/plugin-dialog");
  const ok = await ask(deleteConfirmText(dir, all), {
    title: dir.orphans ? "删除恢复临时文件" : "删除原数据副本",
    kind: "warning",
  });
  if (!ok) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("restore_delete_pre", { name: dir.name });
  return true;
}
