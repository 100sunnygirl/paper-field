import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/repo", () => ({
  repo: {
    init: vi.fn(async () => undefined),
    listDomains: vi.fn(async () => []),
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    listFailedMineru: vi.fn(async () => [] as string[]),
    listPendingMineru: vi.fn(async () => [] as string[]),
    listReadyForMeta: vi.fn(async () => [] as string[]),
    getPaper: vi.fn(async () => null),
    getDomain: vi.fn(async () => null),
  },
}));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("./lib/mineru", async (orig) => {
  const actual = await orig<typeof import("./lib/mineru")>();
  return {
    ...actual,
    loadMineruSettings: vi.fn(async () => actual.DEFAULT_MINERU),
    saveMineruSettings: vi.fn(),
    mineruProbe: vi.fn(async () => []),
  };
});
vi.mock("./lib/biblio", async (orig) => {
  const actual = await orig<typeof import("./lib/biblio")>();
  return { ...actual, loadBiblioSettings: vi.fn(async () => actual.DEFAULT_BIBLIO), saveBiblioSettings: vi.fn() };
});
vi.mock("./lib/settings", () => ({
  loadSettings: vi.fn(async () => ({ version: 2, providers: [], usage: {} })),
  saveSettings: vi.fn(),
  completeChat: vi.fn(),
  cancelChat: vi.fn(),
  hasUsableProvider: () => false,
}));

import { useField } from "./store";
import { DEFAULT_MINERU, loadMineruSettings, saveMineruSettings } from "./lib/mineru";
import { DEFAULT_BIBLIO, loadBiblioSettings, saveBiblioSettings } from "./lib/biblio";
import { clear as clearLog, getEntries } from "./lib/logger";

const errors = () => getEntries().filter((e) => e.level === "error");

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
  clearLog();
  vi.mocked(loadMineruSettings).mockResolvedValue(DEFAULT_MINERU);
  vi.mocked(loadBiblioSettings).mockResolvedValue(DEFAULT_BIBLIO);
  vi.mocked(saveMineruSettings).mockClear();
  vi.mocked(saveBiblioSettings).mockClear();
});

describe("init: settings files that fail to load", () => {
  it("MinerU: falls back to defaults, records the error and logs it", async () => {
    vi.mocked(loadMineruSettings).mockRejectedValue(new Error("MinerU 设置无法解析"));
    await useField.getState().init();
    const s = useField.getState();
    expect(s.ready).toBe(true);
    expect(s.error).toBeNull();
    expect(s.mineru).toEqual(DEFAULT_MINERU);
    expect(s.settingsLoadError).toEqual({ mineru: "MinerU 设置无法解析", biblio: null });
    expect(errors()).toContainEqual(expect.objectContaining({ scope: "mineru" }));
  });

  it("biblio: same behaviour, logged under store", async () => {
    vi.mocked(loadBiblioSettings).mockRejectedValue(new Error("文献库设置无法解析"));
    await useField.getState().init();
    const s = useField.getState();
    expect(s.biblio).toEqual(DEFAULT_BIBLIO);
    expect(s.settingsLoadError).toEqual({ mineru: null, biblio: "文献库设置无法解析" });
    expect(errors()).toContainEqual(expect.objectContaining({ scope: "store" }));
  });

  it("both failing: both recorded, the full-page error path is not taken, nothing is saved", async () => {
    vi.mocked(loadMineruSettings).mockRejectedValue(new Error("m"));
    vi.mocked(loadBiblioSettings).mockRejectedValue(new Error("b"));
    await useField.getState().init();
    const s = useField.getState();
    expect(s.error).toBeNull();
    expect(s.settingsLoadError).toEqual({ mineru: "m", biblio: "b" });
    expect(saveMineruSettings).not.toHaveBeenCalled();
    expect(saveBiblioSettings).not.toHaveBeenCalled();
  });

  it("happy path: no load error and no error log", async () => {
    await useField.getState().init();
    expect(useField.getState().settingsLoadError).toEqual({ mineru: null, biblio: null });
    expect(errors()).toHaveLength(0);
  });
});
