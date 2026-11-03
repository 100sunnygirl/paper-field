import { useEffect, useState } from "react";
import { formatDate } from "../lib/util";
import { useField } from "../store";
import { Button } from "./ui";

type TrashRow = { id: string; name: string; code: string; deletedAt: string; papers: number; daysLeft: number };

/**
 * 领域回收站：误删的整域在 30 天内可从这里恢复（论文、笔记、作者与解析全文一并找回）。
 * 快照存在数据库 app_meta 里（随库备份），不新增表结构。彻底删除走两步确认。
 */
export function DomainTrashCard() {
  const listTrashedDomains = useField((s) => s.listTrashedDomains);
  const restoreTrashedDomain = useField((s) => s.restoreTrashedDomain);
  const purgeTrashedDomain = useField((s) => s.purgeTrashedDomain);
  const [rows, setRows] = useState<TrashRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listTrashedDomains()
      .then((items) => {
        if (alive) setRows(items);
      })
      .catch(() => {
        if (alive) setRows(null);
      });
    return () => {
      alive = false;
    };
  }, [listTrashedDomains]);

  async function restore(id: string) {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      await restoreTrashedDomain(id);
      setRows((current) => current?.filter((row) => row.id !== id) ?? null);
    } catch {
      setError("恢复失败，请重试或查看运行日志。");
    } finally {
      setBusyId(null);
    }
  }

  async function purge(id: string) {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      await purgeTrashedDomain(id);
      setConfirmPurge(null);
      setRows((current) => current?.filter((row) => row.id !== id) ?? null);
    } catch {
      setError("彻底删除失败，请重试。");
    } finally {
      setBusyId(null);
    }
  }

  if (rows !== null && rows.length === 0) return null;

  return (
    <article id="settings-domain-trash" className="page-block pf-stagger" style={{ "--pf-i": 5 } as React.CSSProperties}>
      <header className="ef-block-head">
        <h3>领域回收站</h3>
        <p>删除领域时整域快照保留 30 天：论文、笔记、作者与解析全文都可一并恢复。30 天后自动过期。</p>
      </header>
      {rows === null ? (
        <p className="ef-probe-line">读取回收站失败。</p>
      ) : (
        <ul className="ef-trash-list">
          {rows.map((row) => (
            <li key={row.id}>
              <span className="ef-trash-main">
                <strong>{row.name}</strong>
                <small className="mono">{row.code}</small>
              </span>
              <span className="ef-trash-meta">
                {row.papers} 篇论文 · 删除于 {formatDate(row.deletedAt)} · 剩 {row.daysLeft} 天
              </span>
              <span className="ef-trash-actions">
                {confirmPurge === row.id ? (
                  <>
                    <span className="ef-trash-warn">快照将不可恢复。</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={busyId === row.id}
                      onClick={() => void purge(row.id)}
                    >
                      确认彻底删除
                    </Button>
                    <Button type="button" size="sm" variant="text" onClick={() => setConfirmPurge(null)}>
                      取消
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      disabled={busyId === row.id}
                      onClick={() => void restore(row.id)}
                    >
                      {busyId === row.id ? "恢复中…" : "恢复领域"}
                    </Button>
                    <Button type="button" size="sm" variant="text" onClick={() => setConfirmPurge(row.id)}>
                      彻底删除…
                    </Button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="ef-error">{error}</p> : null}
    </article>
  );
}
