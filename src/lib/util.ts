export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function uid(): string {
  return crypto.randomUUID();
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
}

export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 4).toUpperCase();
}

export function parseJsonArray<T>(raw: string | null | undefined, fallback: T[]): T[] {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as T[];
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }
    throw new Error("模型未返回可解析 JSON");
  }
}

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function modLabel(): string {
  return isMac() ? "⌘" : "Ctrl";
}
