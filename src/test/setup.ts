import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// 未开 globals: true，RTL 不会自动注册 cleanup，需显式清理避免用例间 DOM 残留。
afterEach(() => {
  cleanup();
});

// 任何 import 链都不得触发真实 Tauri IPC：统一替换 invoke。
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));
