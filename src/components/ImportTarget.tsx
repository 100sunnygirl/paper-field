import { useEffect, useRef, useState } from "react";
import { repo } from "../lib/repo";
import { useField } from "../store";
import { Button, Icon } from "./ui";

/**
 * 「将导入到：领域名」常驻选择器：导入对话框顶部与 INTAKE 页头部共用。
 * 目标领域写在 store.importTargetDomainId（null = 跟随当前选中领域），两处共享同一份；
 * 点选领域或就地新建都会改写它，确认按钮据此写明「导入 N 篇到某领域」。
 * 就地新建走 repo.createDomain（不经过 store.createDomain —— 那会切走模式并关掉
 * 导入对话框），成功后刷新领域列表并把新领域落为目标。
 */
export function ImportTarget() {
  const domains = useField((s) => s.domains);
  const selectedDomainId = useField((s) => s.selectedDomainId);
  const importTargetDomainId = useField((s) => s.importTargetDomainId);
  const setImportTargetDomainId = useField((s) => s.setImportTargetDomainId);
  const refresh = useField((s) => s.refresh);
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const targetId = importTargetDomainId ?? selectedDomainId;
  const target = domains.find((d) => d.id === targetId) ?? null;

  // 展开时点在控件之外收起清单（与草稿清单同一手法）；关闭动作本身不冒泡到这里。
  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function createDomain() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const domain = await repo.createDomain({ name, code: "", summary: "" });
      await refresh();
      setImportTargetDomainId(domain.id);
      setNewName("");
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="ef-import-target" ref={rootRef}>
      <button
        type="button"
        className="ef-import-target-btn"
        aria-expanded={open}
        title={target ? `更换导入目标领域（当前：${target.name}）` : "选择导入目标领域"}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="ef-import-target-key">将导入到</span>
        <strong>{target ? `「${target.name}」` : "未选择领域"}</strong>
        <Icon name={open ? "up" : "down"} />
      </button>
      {open ? (
        <div className="ef-import-target-menu" role="group" aria-label="选择导入目标领域">
          {domains.length === 0 ? <p className="ef-import-target-empty">还没有领域，先在下面新建一个。</p> : null}
          {domains.map((domain) => (
            <button
              key={domain.id}
              type="button"
              className={`ef-import-target-option${domain.id === targetId ? " is-current" : ""}`}
              aria-current={domain.id === targetId || undefined}
              onClick={() => {
                setImportTargetDomainId(domain.id);
                setOpen(false);
              }}
            >
              <span>{domain.name}</span>
              {domain.code ? <span className="mono">{domain.code}</span> : null}
            </button>
          ))}
          <div className="ef-import-target-new">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="新建领域名称，如「具身智能」"
              aria-label="新建领域名称"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void createDomain();
                }
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!newName.trim() || creating}
              onClick={() => void createDomain()}
            >
              {creating ? "创建中…" : "新建并设为目标"}
            </Button>
          </div>
          {error ? <p className="ef-error">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
