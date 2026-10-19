import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Node 26 exposes localStorage only with a CLI flag; keep jsdom suites self-contained.
if (typeof localStorage === "undefined") {
  const values = new Map<string, string>();
  globalThis.localStorage = {
    clear: () => values.clear(),
    getItem: (key: string) => (values.has(key) ? values.get(key)! : null),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, String(value)),
  } as Storage;
}

// 未开 globals: true，RTL 不会自动注册 cleanup，需显式清理避免用例间 DOM 残留。
afterEach(() => {
  cleanup();
});

// 任何 import 链都不得触发真实 Tauri IPC：统一替换 invoke。
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
// 文件 / 文件夹对话框已移到 Rust 侧（pick_pdf_files 等命令）；页面只剩确认框。
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  message: vi.fn(),
}));
