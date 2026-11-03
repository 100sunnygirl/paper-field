import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/repo", () => ({
  repo: {
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    getPaper: vi.fn(async (id: string) => ({ id })),
    importLocalPdfs: vi.fn(),
  },
}));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));

import { repo } from "./lib/repo";
import { useField } from "./store";
import { dismissAll, getToasts } from "./toasts";

const importLocalPdfs = repo.importLocalPdfs as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  dismissAll();
  importLocalPdfs.mockReset();
  useField.setState({
    selectedDomainId: "d-1",
    mode: "intake",
    search: "",
    effectiveProvider: "local" as never,
    mineru: { ...useField.getState().mineru, configured: true },
    dialog: null,
  } as never);
});

describe("从入库页发起导入：留在入库页并定位新批次", () => {
  it("不改 mode，选中新批次第一篇，通知带「开始阅读第一篇」动作", async () => {
    importLocalPdfs.mockResolvedValue({ created: [{ id: "p-new" }], skipped: [] });
    await useField.getState().importPdfs(["/x/new.pdf"]);

    expect(useField.getState().mode).toBe("intake");
    expect(useField.getState().selectedPaperId).toBe("p-new");
    const toast = getToasts().find((t) => t.tone === "ok")!;
    expect(toast.text).toContain("已定位到本批第一篇");
    expect(toast.action?.label).toBe("开始阅读第一篇");
  });

  it("有失败篇目时保留失败提示，动作仍是「开始阅读第一篇」", async () => {
    importLocalPdfs.mockImplementation(async (_d: string, [p]: string[]) => {
      if (p.endsWith("bad.pdf")) throw new Error("磁盘已满");
      return { created: [{ id: "p-ok" }], skipped: [] };
    });
    await useField.getState().importPdfs(["/x/ok.pdf", "/x/bad.pdf"]);

    expect(useField.getState().mode).toBe("intake");
    expect(useField.getState().selectedPaperId).toBe("p-ok");
    const toast = getToasts().find((t) => t.tone === "error")!;
    expect(toast.text).toContain("bad.pdf（磁盘已满）");
    expect(toast.action?.label).toBe("开始阅读第一篇");
  });

  it("现场模式发起导入维持原有跳转（mode=field、无阅读动作）", async () => {
    useField.setState({ mode: "field" } as never);
    importLocalPdfs.mockResolvedValue({ created: [{ id: "p-f" }], skipped: [] });
    await useField.getState().importPdfs(["/x/f.pdf"]);

    expect(useField.getState().mode).toBe("field");
    expect(useField.getState().selectedPaperId).toBe("p-f");
    const toast = getToasts().find((t) => t.tone === "ok")!;
    expect(toast.text).not.toContain("已定位到本批第一篇");
    expect(toast.action).toBeUndefined();
  });
});
