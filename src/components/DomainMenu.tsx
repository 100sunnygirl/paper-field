import { useEffect, useRef, useState } from "react";
import { repo } from "../lib/repo";
import type { DomainCensus } from "../lib/types";
import { shortcut } from "../lib/util";
import { useField } from "../store";
import { Icon } from "./ui";

/**
 * 领域快捷切换：列表头的领域名点击不再进对话框，而是就地展开一个下拉——
 * 各领域带阅读进度（已读 n / 总数 + 迷你进度条），点击即切；⌘1-9 / ⌘↑⌘↓ 直达。
 * 完整管理（编辑 / 新建 / 排序 / 回收站）仍走底部「管理领域…」进领域选择对话框。
 */
export function DomainMenu() {
  const domains = useField((s) => s.domains);
  const selectedDomainId = useField((s) => s.selectedDomainId);
  const selectDomain = useField((s) => s.selectDomain);
  const openDialog = useField((s) => s.openDialog);
  const [open, setOpen] = useState(false);
  const [census, setCensus] = useState<Record<string, DomainCensus> | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const domain = domains.find((d) => d.id === selectedDomainId) ?? null;

  // 打开时读一次各领域进度；读不到（测试引擎缺失等）行内降级为只显示名称与短码。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    repo
      .domainCensus()
      .then((rows) => {
        if (alive) setCensus(Object.fromEntries(rows.map((row) => [row.domainId, row])));
      })
      .catch(() => {
        if (alive) setCensus(null);
      });
    return () => {
      alive = false;
    };
  }, [open, domains]);

  // 外点与 Esc 收起（Esc 在 window 捕获层之前先收菜单，不打断阅读）。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="ef-domain-menu-wrap" ref={rootRef}>
      <button
        type="button"
        className="ef-domain-picker"
        aria-label={domain?.name ? `切换研究领域：${domain.name}` : "切换研究领域"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <h2>{domain?.name ?? "未选择领域"}</h2>
        <span className="ef-domain-select" aria-hidden="true">
          <Icon name="down" />
        </span>
      </button>
      {open ? (
        <div className="ef-domain-menu" role="menu" aria-label="领域快捷切换">
          {domains.map((item, index) => {
            const stat = census?.[item.id] ?? null;
            const read = stat?.read ?? 0;
            const total = stat?.total ?? 0;
            const fill = total ? Math.round((read / total) * 100) : 0;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className={`ef-domain-menu-item ${item.id === selectedDomainId ? "is-current" : ""}`}
                aria-current={item.id === selectedDomainId ? "true" : undefined}
                onClick={() => {
                  setOpen(false);
                  if (item.id !== selectedDomainId) void selectDomain(item.id);
                }}
              >
                <span className="ef-domain-menu-main">
                  <span className="ef-domain-menu-name">
                    {item.id === selectedDomainId ? <Icon name="check" /> : null}
                    {item.name}
                  </span>
                  <span className="ef-domain-menu-meta mono">
                    {item.code}
                    {stat ? ` · 已读 ${read} / ${total}` : ""}
                  </span>
                  {stat && total ? (
                    <span className="ef-domain-menu-bar" aria-hidden="true">
                      <i style={{ width: `${fill}%` }} />
                    </span>
                  ) : null}
                </span>
                {index < 9 ? <kbd>{shortcut(String(index + 1))}</kbd> : null}
              </button>
            );
          })}
          <div className="ef-domain-menu-foot">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                openDialog("pick-domain");
              }}
            >
              管理领域…
              <Icon name="right" />
            </button>
            <span className="ef-domain-menu-hint">⌘1-9 直达 · ⌘↑⌘↓ 切换</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
