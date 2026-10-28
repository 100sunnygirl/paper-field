/**
 * AI 动作的本机偏好（localStorage，键 paper-field.*）：不走设置页 JSON，
 * 只影响本机交互方式，不改变任何写库语义。
 */

/** 「先预览再写入」：补全论文信息先出干跑预览，确认后才写库。 */
const PREVIEW_FIRST_KEY = "paper-field.ai-preview-first";

export function loadPreviewFirst(): boolean {
  try {
    return localStorage.getItem(PREVIEW_FIRST_KEY) === "1";
  } catch {
    return false;
  }
}

export function savePreviewFirst(on: boolean): void {
  try {
    if (on) localStorage.setItem(PREVIEW_FIRST_KEY, "1");
    else localStorage.removeItem(PREVIEW_FIRST_KEY);
  } catch {
    // 隐私模式等存不下：本次会话仍按内存状态生效。
  }
}
