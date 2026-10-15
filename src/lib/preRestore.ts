import { formatBytes } from "./backup";

/** One `pre-restore-<ms>` copy kept from a past restore (mirrors Rust `PreDir`). */
export interface PreDir {
  name: string;
  path: string;
  createdMs: number;
  bytes: number;
  hasDb: boolean;
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
  const lines = [`删除 ${dir.name}（${formatBytes(dir.bytes)}）？`];
  if (dir.hasDb && all.filter((d) => d.hasDb).length === 1) {
    lines.push("这是唯一一份可回滚的原数据。");
  }
  lines.push("此操作不可撤销。");
  return lines.join("\n");
}

/** Returns true when the folder was deleted. */
export async function deletePreDir(dir: PreDir, all: PreDir[]): Promise<boolean> {
  const { ask } = await import("@tauri-apps/plugin-dialog");
  const ok = await ask(deleteConfirmText(dir, all), { title: "删除原数据副本", kind: "warning" });
  if (!ok) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("restore_delete_pre", { name: dir.name });
  return true;
}
