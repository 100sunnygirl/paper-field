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

/** 笔记起草风格（注入提示词；本机偏好，不改写库语义）。 */
export type NoteStyle = "concise" | "critical" | "experimental";

const NOTE_STYLE_KEY = "paper-field.note-style";

export const NOTE_STYLE_LABELS: Record<NoteStyle, string> = {
  concise: "简洁",
  critical: "批判",
  experimental: "重实验",
};

export function loadNoteStyle(): NoteStyle {
  try {
    const raw = localStorage.getItem(NOTE_STYLE_KEY);
    return raw === "critical" || raw === "experimental" ? raw : "concise";
  } catch {
    return "concise";
  }
}

export function saveNoteStyle(style: NoteStyle): void {
  try {
    localStorage.setItem(NOTE_STYLE_KEY, style);
  } catch {
    // 存不下只影响下次默认，本次仍按所选风格生效。
  }
}

export function noteStylePrompt(style: NoteStyle): string {
  if (style === "critical") return "Reader style: 批判性视角——重点评估证据强度、方法漏洞与结论边界，敢于指出弱点。";
  if (style === "experimental") return "Reader style: 实验视角——关注可复现性、数据集/指标、训练与推理成本、可落地的实验改动。";
  return "Reader style: 简洁——每块尽量短，只保留关键信息。";
}

/**
 * 自动补全旧论文的开关（本机偏好）：关闭时保存设置 / 启动不再自动排回填，
 * 显式「启用自动补全」与单篇手动补全不受影响。
 */
const BACKFILL_AUTO_KEY = "paper-field.auto-backfill";

export function loadAutoBackfill(): boolean {
  try {
    return localStorage.getItem(BACKFILL_AUTO_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveAutoBackfill(on: boolean): void {
  try {
    if (on) localStorage.removeItem(BACKFILL_AUTO_KEY);
    else localStorage.setItem(BACKFILL_AUTO_KEY, "0");
  } catch {
    // 存不下只影响本次会话的记忆。
  }
}
