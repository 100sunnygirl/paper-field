import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { OPEN_SOURCE_LABELS, type OpenSource } from "../lib/types";

export type ButtonVariant = "primary" | "secondary" | "text" | "danger" | "link";
export type ButtonSize = "md" | "sm";

const ICONS = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </>
  ),
  archive: <path d="M4 8h16v12H4zM3 4h18v4H3zM9 12h6" />,
  inbox: <path d="M4 4h16l2 11v5H2v-5zM2 15h6l2 3h4l2-3h6M12 4v8m-3-3 3 3 3-3" />,
  settings: (
    <>
      <path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  down: <path d="m6 9 6 6 6-6" />,
  right: <path d="m9 6 6 6-6 6" />,
  external: <path d="M14 3h7v7m0-7L10 14M10 4H4v16h16v-6" />,
  file: <path d="M5 3h9l5 5v13H5zM14 3v5h5M8 13h8M8 17h6" />,
  edit: <path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z" />,
  focus: <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5" />,
  check: <path d="m5 12 4 4L19 6" />,
  code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-16-2 20" />,
  link: <path d="m10 7 3-3a5 5 0 0 1 7 7l-3 3M7 10l-3 3a5 5 0 0 0 7 7l3-3m-6 1 8-8" />,
  spark: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 2v4m-2-2h4" />,
  close: <path d="m5 5 14 14M19 5 5 19" />,
  menu: <path d="M3 6h18M3 12h18M3 18h18" />,
  trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />,
  batch: (
    <>
      <rect x="4" y="4" width="16" height="16" />
      <path d="m8 12 3 3 6-7" />
    </>
  ),
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg className={`ef-ico ${className}`.trim()} viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const cls = ["ef-btn", `ef-btn-${variant}`, size === "sm" ? "ef-btn-sm" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={cls} {...props}>
      {children}
    </button>
  );
}

export function ButtonLink({
  variant = "secondary",
  size = "md",
  className = "",
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const cls = ["ef-btn", `ef-btn-${variant}`, size === "sm" ? "ef-btn-sm" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <a className={cls} {...props}>
      {children}
    </a>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  title,
  onClose,
  vetoClose,
  children,
  footer,
  className = "",
  danger = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** 返回 true 表示本次关闭被否决（如存在未保存修改）；提示由回调自身负责。 */
  vetoClose?: () => boolean;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  danger?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const [hasVetoedOnce, setHasVetoedOnce] = useState(false);

  useEffect(() => {
    if (open) setHasVetoedOnce(false);
  }, [open]);

  // 统一关闭入口：backdrop、Escape、header 关闭按钮都经此走。
  // 否决分支必须继续 stopPropagation——否则事件冒泡到 window 层，
  // App 的无条件 closeDialog() 仍会关掉对话框，否决形同虚设。
  const guardClose = useCallback(
    (event?: { stopPropagation: () => void }) => {
      if (vetoClose && !hasVetoedOnce && vetoClose()) {
        event?.stopPropagation();
        setHasVetoedOnce(true);
        return;
      }
      event?.stopPropagation();
      onClose();
    },
    [hasVetoedOnce, onClose, vetoClose],
  );

  // 用 ref 透传 guardClose，避免回调引用变化导致焦点 effect 重跑、焦点被拉回首元素。
  const guardRef = useRef(guardClose);
  useEffect(() => {
    guardRef.current = guardClose;
  });

  useEffect(() => {
    if (!open) return;
    lastFocus.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
        (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
      );
    const first = focusables()[0];
    first?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        guardRef.current(event);
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const nodes = focusables();
      if (!nodes.length) return;
      const firstNode = nodes[0];
      const lastNode = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === firstNode) {
        event.preventDefault();
        lastNode.focus();
      } else if (!event.shiftKey && document.activeElement === lastNode) {
        event.preventDefault();
        firstNode.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      lastFocus.current?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="ef-backdrop"
      role="presentation"
      onMouseDown={(e) => guardClose(e)}
    >
      <div
        ref={panelRef}
        className={`ef-dialog ${danger ? "is-danger" : ""} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="ef-dialog-head">
          <h2 id={titleId}>{title}</h2>
          <Button
            type="button"
            variant="text"
            className="ef-icon-btn"
            onClick={() => guardClose()}
            aria-label="关闭对话框"
          >
            <Icon name="close" />
          </Button>
        </header>
        <div className="ef-dialog-body">{children}</div>
        {footer ? <footer className="ef-dialog-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  light?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="ef-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p>{body}</p>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function OpenChip({ value }: { value: string }) {
  const key = (value in OPEN_SOURCE_LABELS ? value : "unknown") as OpenSource;
  return <span className={`ef-chip ${key}`}>{OPEN_SOURCE_LABELS[key]}</span>;
}

export function ExternalResource({
  href,
  icon,
  children,
}: {
  href: string;
  icon: IconName;
  children: ReactNode;
}) {
  return (
    <a className="ef-resource-link" href={href} target="_blank" rel="noreferrer">
      <Icon name={icon} />
      <span>{children}</span>
      <Icon name="external" />
    </a>
  );
}
