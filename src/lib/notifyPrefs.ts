// 作业完成通知的偏好（localStorage 键 paper-field.job-notify，非敏感、本机保存）。
// mineruRun 在批次收尾时读取：控制「完成时提醒我」的总开关、批次汇总 / 仅失败 / 逐篇三种
// 口径，以及窗口失焦时的系统级通知。读不到 / 值损坏时回默认值，不影响任何批处理流程。

export type JobNotifyMode = "summary" | "failures" | "perItem";

export interface JobNotifyPrefs {
  /** 完成时提醒我（批次收尾汇总 / 逐篇提醒的总开关）。 */
  enabled: boolean;
  /** 批次汇总 / 仅失败 / 逐篇。 */
  mode: JobNotifyMode;
  /** 窗口失焦时发系统级通知（需通知权限；环境不支持时静默跳过）。 */
  system: boolean;
}

const KEY = "paper-field.job-notify";

export const DEFAULT_JOB_NOTIFY: JobNotifyPrefs = { enabled: true, mode: "summary", system: false };

const MODES: JobNotifyMode[] = ["summary", "failures", "perItem"];

export function loadJobNotifyPrefs(): JobNotifyPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_JOB_NOTIFY };
    const value = JSON.parse(raw) as Partial<JobNotifyPrefs>;
    return {
      enabled: value.enabled !== false,
      mode: MODES.includes(value.mode as JobNotifyMode) ? (value.mode as JobNotifyMode) : DEFAULT_JOB_NOTIFY.mode,
      system: value.system === true,
    };
  } catch {
    return { ...DEFAULT_JOB_NOTIFY };
  }
}

export function saveJobNotifyPrefs(prefs: JobNotifyPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // 存不下（隐私模式等）也不影响功能：本次会话内偏好仍在内存里生效。
  }
}

/** 测试专用：清掉本机偏好。 */
export function resetJobNotifyPrefs(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export type SystemNotifyPermission = "granted" | "denied" | "default" | "unsupported";

/** 当前环境有没有系统通知能力（Notification API）。 */
export function systemNotifySupported(): boolean {
  return typeof Notification !== "undefined";
}

/**
 * 请求系统通知权限（用户打开「失焦系统通知」开关时调用一次）。
 * 环境不支持时返回 "unsupported"，调用方据此提示并保持关闭。
 */
export async function requestSystemNotifyPermission(): Promise<SystemNotifyPermission> {
  if (!systemNotifySupported()) return "unsupported";
  try {
    return (await Notification.requestPermission()) as SystemNotifyPermission;
  } catch {
    return Notification.permission === "granted" ? "granted" : "denied";
  }
}

/**
 * 发一条系统级通知。所有前提逐一兜底：无 Notification API、权限未授予、窗口仍聚焦、
 * 传参异常，都静默跳过（面板内的 toast 通知不受影响）。
 */
export function systemNotify(title: string, body: string): void {
  try {
    if (!systemNotifySupported() || Notification.permission !== "granted") return;
    if (typeof document !== "undefined" && document.hasFocus()) return;
    const notice = new Notification(title, { body });
    notice.onclick = () => {
      try {
        window.focus();
        notice.close();
      } catch {
        // ignore
      }
    };
  } catch {
    // 通知发不出去不打断批处理。
  }
}
