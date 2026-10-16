import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const calls: string[] = [];
const invoke = vi.fn(async (cmd: string) => {
  calls.push(cmd);
  if (cmd === "restore_status") return status;
  // 第一条数据库命令就停下：只关心它是否排在 restore_status 之后。
  throw new Error("stop at first db command");
});
let status: unknown = { kind: "none" };
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string) => invoke(cmd) }));

import { getEngine, resetEngine, RestoreStuckError } from "./engine";

beforeEach(() => {
  calls.length = 0;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});
afterEach(async () => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  await resetEngine();
});

describe("engine startup with a pending restore", () => {
  it("checks restore_status before any database command", async () => {
    status = { kind: "none" };
    await expect(getEngine()).rejects.toThrow("stop at first db command");
    expect(calls[0]).toBe("restore_status");
    expect(calls[1]).toMatch(/^db_/);
  });

  it.each([true, false])("stuck (dbAvailable=%s) never opens the database", async (dbAvailable) => {
    status = { kind: "stuck", pre: "/d/pre-restore-1", dbAvailable };
    await expect(getEngine()).rejects.toBeInstanceOf(RestoreStuckError);
    expect(calls).toEqual(["restore_status"]);
  });
});
