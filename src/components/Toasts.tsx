import { useSyncExternalStore, type CSSProperties } from "react";
import {
  TOAST_DURATION,
  dismiss,
  getToasts,
  getVersion,
  pause,
  resume,
  subscribe,
  type ToastItem,
} from "../toasts";

/** 读屏级别前缀：视觉隐藏，让 polite 的 status 也能念出级别。 */
const TONE_PREFIX: Record<ToastItem["tone"], string> = { ok: "成功", warn: "提醒", error: "错误" };

function ToastRow({ toast }: { toast: ToastItem }) {
  const life = toast.durationMs ?? TOAST_DURATION[toast.tone];
  return (
    <div
      className={`ef-toast ${toast.tone}`}
      // 错误类用 assertive 的 alert 即时打断播报；ok / warn 用 polite 的 status。
      role={toast.tone === "error" ? "alert" : "status"}
      // 悬停 / 聚焦（捕获，含关闭按钮）暂停自动消退，离开 / 失焦接续剩余时长。
      onMouseEnter={() => pause(toast.id)}
      onMouseLeave={() => resume(toast.id)}
      onFocusCapture={() => pause(toast.id)}
      onBlurCapture={() => resume(toast.id)}
    >
      <span className="sr-only">{TONE_PREFIX[toast.tone]}：</span>
      <span>{toast.text}</span>
      {toast.action ? (
        <button
          type="button"
          className="ef-toast-action"
          onClick={() => {
            const { run } = toast.action!;
            dismiss(toast.id, "manual");
            run();
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="ef-toast-close"
        aria-label="关闭通知"
        onClick={() => dismiss(toast.id, "manual")}
      >
        ×
      </button>
      {/* 停留倒计时条：与 JS 计时同源（时长同值、悬停 / 聚焦同步暂停）；
          去重刷新时 rev 变化重挂，倒计时从头开始。0 = 不自动消退，不渲染。 */}
      {life > 0 ? (
        <i
          key={toast.rev ?? 0}
          className="ef-toast-life"
          aria-hidden="true"
          style={{ "--pf-toast-life": `${life}ms` } as CSSProperties}
        />
      ) : null}
    </div>
  );
}

/** 通知堆叠容器：右上一列（窄屏底部反转堆叠），空堆叠时不渲染任何节点。 */
export function Toasts() {
  // getSnapshot 返回版本号原始值；堆叠列表另行读取（两段式，避免无限重渲染）。
  useSyncExternalStore(subscribe, getVersion);
  const items = getToasts();
  if (!items.length) return null;
  return (
    <div className="ef-toast-stack">
      {items.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
