import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let answer = true;
vi.mock("./util", () => ({ isTauri: () => true }));
vi.mock("./engine", () => ({
  resetEngine: vi.fn(async () => calls.push("reset")),
  getEngine: async () => ({ select: async () => [{ n: 3 }] }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: async () => "/tmp/b.zip",
  ask: vi.fn(async (msg: string) => {
    calls.push(`ask:${msg}`);
    return answer;
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    calls.push(cmd);
    return cmd === "restore_library_backup"
      ? { papers: 7, latestUpdatedAt: "2026-10-13T09:00:00Z", pdfs: 2, zipBytes: 3 * 1024 * 1024 }
      : undefined;
  }),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => calls.push("relaunch")) }));

import { restoreConfirmText, restoreLibrary } from "./backup";

beforeEach(() => {
  calls.length = 0;
});

describe("restore confirmation", () => {
  it("confirm relaunches after staging", async () => {
    answer = true;
    expect(await restoreLibrary()).toBe(true);
    expect(calls.filter((c) => !c.startsWith("ask:"))).toEqual(["restore_library_backup", "restore_commit_preview", "reset", "relaunch"]);
    const msg = calls.find((c) => c.startsWith("ask:"))!;
    expect(msg).toContain("7 篇文献，2 个 PDF，3.0 MB");
    expect(msg).toContain("当前文库：3 篇文献");
  });
  it("cancel abandons and never relaunches", async () => {
    answer = false;
    expect(await restoreLibrary()).toBe(false);
    expect(calls.filter((c) => !c.startsWith("ask:"))).toEqual(["restore_library_backup", "restore_abandon"]);
  });
  it("unknown values read as 未知", () => {
    const t = restoreConfirmText({ papers: 0, latestUpdatedAt: null, pdfs: 0, zipBytes: 10 }, null);
    expect(t).toContain("最近更新：未知");
    expect(t).toContain("当前文库：未知");
    expect(t).toContain("1 KB");
  });
  it("warns when the backup has fewer papers, but not when current is unknown", () => {
    const b = { papers: 4, latestUpdatedAt: null, pdfs: 0, zipBytes: 10 };
    expect(restoreConfirmText(b, 10)).toContain("备份比当前少 6 篇");
    expect(restoreConfirmText(b, 4)).not.toContain("备份比当前少");
    expect(restoreConfirmText(b, null)).not.toContain("备份比当前少");
  });
});
