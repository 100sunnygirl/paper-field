import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let answer = true;
vi.mock("./util", () => ({ isTauri: () => true }));
vi.mock("./engine", () => ({
  resetEngine: vi.fn(async () => calls.push("reset")),
  getEngine: async () => ({ select: async () => [{ n: 3 }] }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
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

import {
  BACKUP_STALE_DAYS,
  daysSinceBackup,
  readLastBackup,
  restoreConfirmText,
  restoreLibrary,
  writeLastBackup,
} from "./backup";

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
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
  it("tells the user which restored settings stay off", () => {
    const b = { papers: 1, latestUpdatedAt: null, pdfs: 0, zipBytes: 10 };
    const settingsNotice = "为安全起见，备份中的设置没有直接生效：LLM 提供商已全部停用，已保存的 API Key 需要重新填写。请在设置中核对地址后再启用。";
    expect(restoreConfirmText({ ...b, settingsNotice }, 1)).toContain(settingsNotice);
    expect(restoreConfirmText({ ...b, settingsNotice: null }, 1)).not.toContain("为安全起见");
  });
});

describe("restore cancelled in the file dialog", () => {
  it("returns false without staging or asking", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockImplementationOnce(async (cmd: string) => {
      calls.push(cmd);
      return null;
    });
    expect(await restoreLibrary()).toBe(false);
    expect(calls).toEqual(["restore_library_backup"]);
  });
});

describe("上次备份记录（localStorage）", () => {
  it("readLastBackup 在无记录或坏数据时返回 null", () => {
    expect(readLastBackup()).toBeNull();
    localStorage.setItem("paper-field.last-backup", "not-json{{");
    expect(readLastBackup()).toBeNull();
    localStorage.setItem("paper-field.last-backup", JSON.stringify({ at: "x" }));
    expect(readLastBackup()).toBeNull();
  });

  it("writeLastBackup 后可完整读回（时间 / 位置 / 规模）", () => {
    const record = { at: 1770000000000, where: "/Volumes/backup/paper-field-20261026.zip", papers: 12, pdfs: 9 };
    writeLastBackup(record);
    expect(readLastBackup()).toEqual(record);
  });

  it("daysSinceBackup 按整天计，不足一天为 0", () => {
    const now = Date.UTC(2026, 9, 27, 12, 0, 0);
    expect(daysSinceBackup(now - 3600_000, now)).toBe(0);
    expect(daysSinceBackup(now - 3 * 86400_000, now)).toBe(3);
    expect(BACKUP_STALE_DAYS).toBeGreaterThanOrEqual(1);
  });
});
