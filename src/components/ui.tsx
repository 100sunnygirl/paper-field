import type { ReactNode } from "react";

export function Button({
  primary,
  ink,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; ink?: boolean }) {
  const cls = ["ef-btn", primary ? "primary" : "", ink ? "ink" : "", className]
    .filter(Boolean)
    .join(" ");
  return <button className={cls} {...props} />;
}

export function Dialog({
  open,
  kicker,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  kicker: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="ef-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="ef-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <p>{kicker}</p>
            <h2 id="dialog-title">{title}</h2>
          </div>
          <Button type="button" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </header>
        <div className="body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Field({
  label,
  light,
  children,
}: {
  label: string;
  light?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`ef-field ${light ? "light" : ""}`}>
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
      {action ? <div style={{ marginTop: 16 }}>{action}</div> : null}
    </div>
  );
}

export function OpenChip({ value }: { value: string }) {
  const label =
    value === "open" ? "OPEN" : value === "closed" ? "CLOSED" : value === "request" ? "REQUEST" : "?";
  return <span className={`ef-chip ${value}`}>{label}</span>;
}
