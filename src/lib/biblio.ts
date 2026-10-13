import { isTauri } from "./util";

export interface BiblioStatus {
  email: string;
  hasOpenalexKey: boolean;
  hasS2Key: boolean;
  openalexRemainingUsd: number | null;
  openalexLimitUsd: number | null;
}

/** `null` keeps the saved key, `""` clears it, any other string replaces it. */
export interface BiblioSaveInput {
  email: string;
  openalexKey: string | null;
  s2Key: string | null;
}

export const DEFAULT_BIBLIO: BiblioStatus = {
  email: "",
  hasOpenalexKey: false,
  hasS2Key: false,
  openalexRemainingUsd: null,
  openalexLimitUsd: null,
};

const EMAIL_KEY = "paper-field.biblio";
const OPENALEX_KEY = "paper-field.biblio.openalex";
const S2_KEY = "paper-field.biblio.s2";

export function biblioEmailConfigured(email: string): boolean {
  const value = email.trim();
  return value.includes("@") && !/\s/.test(value);
}

function readBrowser(): BiblioStatus {
  try {
    const raw = localStorage.getItem(EMAIL_KEY);
    const parsed = raw ? (JSON.parse(raw) as { email?: string }) : {};
    const openalex = localStorage.getItem(OPENALEX_KEY) ?? "";
    const s2 = localStorage.getItem(S2_KEY) ?? "";
    return {
      email: typeof parsed.email === "string" ? parsed.email : "",
      hasOpenalexKey: Boolean(openalex),
      hasS2Key: Boolean(s2),
      openalexRemainingUsd: null,
      openalexLimitUsd: null,
    };
  } catch {
    return { ...DEFAULT_BIBLIO };
  }
}

function writeBrowserKey(storageKey: string, value: string | null): void {
  if (value === null) return;
  if (value.trim()) localStorage.setItem(storageKey, value.trim());
  else localStorage.removeItem(storageKey);
}

function normalizeStatus(value: Partial<BiblioStatus> | null | undefined): BiblioStatus {
  return {
    email: typeof value?.email === "string" ? value.email : "",
    hasOpenalexKey: Boolean(value?.hasOpenalexKey),
    hasS2Key: Boolean(value?.hasS2Key),
    openalexRemainingUsd: typeof value?.openalexRemainingUsd === "number" ? value.openalexRemainingUsd : null,
    openalexLimitUsd: typeof value?.openalexLimitUsd === "number" ? value.openalexLimitUsd : null,
  };
}

export async function loadBiblioSettings(): Promise<BiblioStatus> {
  if (!isTauri()) return readBrowser();
  const { invoke } = await import("@tauri-apps/api/core");
  return normalizeStatus(await invoke<BiblioStatus>("biblio_settings"));
}

export async function saveBiblioSettings(input: BiblioSaveInput): Promise<BiblioStatus> {
  if (!isTauri()) {
    writeBrowserKey(OPENALEX_KEY, input.openalexKey);
    writeBrowserKey(S2_KEY, input.s2Key);
    const email = input.email.trim();
    localStorage.setItem(EMAIL_KEY, JSON.stringify({ email }));
    return readBrowser();
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return normalizeStatus(await invoke<BiblioStatus>("save_biblio_settings", { input }));
}
