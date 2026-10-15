import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const calls: string[] = [];
const invoke = vi.fn(async (cmd: string) => {
  calls.push(cmd);
  return status;
});
let status: unknown = { kind: "none" };
const load = vi.fn(async () => {
  calls.push("Database.load");
  throw new Error("stop after load");
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string) => invoke(cmd) }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: () => load() } }));

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
  it("checks restore_status before Database.load", async () => {
    status = { kind: "none" };
    await expect(getEngine()).rejects.toThrow("stop after load");
    expect(calls).toEqual(["restore_status", "Database.load"]);
  });

  it.each([true, false])("stuck (dbAvailable=%s) never loads the database", async (dbAvailable) => {
    status = { kind: "stuck", pre: "/d/pre-restore-1", dbAvailable };
    await expect(getEngine()).rejects.toBeInstanceOf(RestoreStuckError);
    expect(calls).toEqual(["restore_status"]);
    expect(calls).not.toContain("Database.load");
  });
});
