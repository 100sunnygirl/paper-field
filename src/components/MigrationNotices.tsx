import { useEffect, useState } from "react";
import { isTauri } from "../lib/util";

export type DirMigrationNotice = {
  kind: string;
  oldPath: string;
  newPath: string;
};

/** One sentence per directory. Config, data, and local stay separate lines. */
export function migrationNoticeText(notice: DirMigrationNotice): string {
  const name =
    notice.kind === "config" ? "配置" : notice.kind === "local" ? "本机数据" : "数据";
  return `${name}目录已有内容，没有从 ${notice.oldPath} 覆盖。旧目录仍保留。`;
}

export function MigrationNotices({ initial }: { initial?: DirMigrationNotice[] }) {
  const [notices, setNotices] = useState<DirMigrationNotice[] | null>(initial ?? null);

  useEffect(() => {
    if (initial || !isTauri()) return;
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      setNotices(await invoke<DirMigrationNotice[]>("appdir_migration_notices"));
    })().catch(() => undefined);
  }, [initial]);

  if (!notices?.length) return null;

  return (
    <div className="migration-notices">
      {notices.map((notice) => (
        <p key={`${notice.kind}:${notice.oldPath}`} role="status">
          {migrationNoticeText(notice)}
        </p>
      ))}
    </div>
  );
}
