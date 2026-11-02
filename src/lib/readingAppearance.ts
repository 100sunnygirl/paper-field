/**
 * 正文阅读外观（本机 localStorage 记忆）：字号档位 + 行宽档位。
 * 记忆分两层——本机默认 + 按论文覆盖：某篇论文调过就只影响这篇
 * （「恢复默认」清掉本篇覆盖），「应用到所有论文」把当前档位提为本机默认。
 */

export type ReadWidthStep = "narrow" | "standard" | "wide";

export interface ReadingAppearance {
  /** 字号档位：0 更小 · 1 小 · 2 标准 · 3 大 · 4 更大（对应 FONT_STEPS 缩放）。 */
  fontStep: number;
  /** 行宽档位。 */
  width: ReadWidthStep;
}

export interface AppearanceStore {
  default: ReadingAppearance;
  papers: Record<string, ReadingAppearance>;
}

/** 字号档位 → 正文缩放倍率（作用于 --pf-read-scale）。 */
export const FONT_STEPS = [0.85, 0.925, 1, 1.1, 1.2] as const;

/** 字号档位的中文标签（控件与播报共用）。 */
export const FONT_STEP_LABELS = ["更小", "小", "标准", "大", "更大"] as const;

/** 行宽档位 → 正文栏宽缩放倍率（作用于 --pf-read-width-scale）。 */
export const WIDTH_SCALES: Record<ReadWidthStep, number> = {
  narrow: 0.85,
  standard: 1,
  wide: 1.2,
};

export const WIDTH_STEP_LABELS: Record<ReadWidthStep, string> = {
  narrow: "窄",
  standard: "标准",
  wide: "宽",
};

export const DEFAULT_APPEARANCE: ReadingAppearance = { fontStep: 2, width: "standard" };

const KEY = "paper-field.read-appearance";

function isAppearance(value: unknown): value is ReadingAppearance {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ReadingAppearance>;
  return (
    typeof item.fontStep === "number" &&
    Number.isInteger(item.fontStep) &&
    item.fontStep >= 0 &&
    item.fontStep < FONT_STEPS.length &&
    (item.width === "narrow" || item.width === "standard" || item.width === "wide")
  );
}

function normalizeStore(value: unknown): AppearanceStore {
  const store: AppearanceStore = { default: { ...DEFAULT_APPEARANCE }, papers: {} };
  if (!value || typeof value !== "object") return store;
  const raw = value as Partial<AppearanceStore>;
  if (isAppearance(raw.default)) store.default = { ...raw.default };
  if (raw.papers && typeof raw.papers === "object") {
    for (const [paperId, appearance] of Object.entries(raw.papers)) {
      if (isAppearance(appearance)) store.papers[paperId] = { ...appearance };
    }
  }
  return store;
}

/** 读取本机偏好；损坏 / 缺失回落默认（字号标准、行宽标准）。 */
export function loadAppearanceStore(): AppearanceStore {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    return raw ? normalizeStore(JSON.parse(raw) as unknown) : { default: { ...DEFAULT_APPEARANCE }, papers: {} };
  } catch {
    return { default: { ...DEFAULT_APPEARANCE }, papers: {} };
  }
}

function persist(store: AppearanceStore): AppearanceStore {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // 存不下（隐私模式等）：本会话仍生效。
  }
  return store;
}

/** 某篇论文的生效外观：本篇覆盖优先，否则本机默认。 */
export function getAppearance(store: AppearanceStore, paperId: string | null | undefined): ReadingAppearance {
  if (paperId && store.papers[paperId]) return store.papers[paperId];
  return store.default;
}

/** 这篇论文有没有本篇覆盖档位（「恢复默认」按钮的可见依据）。 */
export function hasPaperAppearance(store: AppearanceStore, paperId: string | null | undefined): boolean {
  return Boolean(paperId && store.papers[paperId]);
}

/** 调整这篇论文的外观（写本篇覆盖）。 */
export function setPaperAppearance(store: AppearanceStore, paperId: string, appearance: ReadingAppearance): AppearanceStore {
  if (!paperId || !isAppearance(appearance)) return store;
  return persist({ ...store, papers: { ...store.papers, [paperId]: { ...appearance } } });
}

/** 清掉这篇论文的本篇覆盖，回到本机默认。 */
export function clearPaperAppearance(store: AppearanceStore, paperId: string): AppearanceStore {
  if (!store.papers[paperId]) return store;
  const papers = { ...store.papers };
  delete papers[paperId];
  return persist({ ...store, papers });
}

/** 把当前档位提为本机默认（未覆盖的论文随之生效）。 */
export function setDefaultAppearance(store: AppearanceStore, appearance: ReadingAppearance): AppearanceStore {
  if (!isAppearance(appearance)) return store;
  return persist({ ...store, default: { ...appearance } });
}
