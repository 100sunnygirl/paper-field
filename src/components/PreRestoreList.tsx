import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "../lib/backup";
import { deletePreDir, listPreDirs, type PreList } from "../lib/preRestore";
import { formatDate, isTauri } from "../lib/util";
import { Button } from "./ui";

/** Copies of the library taken before each restore, with per-row delete. */
export function PreRestoreList() {
  const [list, setList] = useState<PreList | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setList(await listPreDirs());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (isTauri()) void refresh();
  }, [refresh]);

  if (!list || list.dirs.length === 0) return null;
  const newestRollback = list.dirs.find((d) => !d.orphans)?.name;

  return (
    <div className="pf-pre-restore">
      <h4>恢复前的原数据</h4>
      {list.busy ? <p>恢复还没处理完，暂不能清理。</p> : null}
      <ul>
        {list.dirs.map((d) => (
          <li key={d.name}>
            <span>
              {formatDate(new Date(d.createdMs).toISOString())} · {formatBytes(d.bytes)}
              {d.orphans ? "（临时文件）" : d.name === newestRollback ? "（最近一次）" : ""}
            </span>
            <Button
              type="button"
              disabled={list.busy}
              aria-label={`删除 ${d.name}`}
              onClick={async () => {
                setError("");
                try {
                  if (await deletePreDir(d, list.dirs)) await refresh();
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              删除
            </Button>
          </li>
        ))}
      </ul>
      {error ? <p role="status">操作失败：{error}</p> : null}
    </div>
  );
}
