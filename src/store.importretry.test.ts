import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/repo", () => ({
  repo: {
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    getPaper: vi.fn(async () => null),
    importLocalPdfs: vi.fn(),
  },
}));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));

import { Toasts } from "./components/Toasts";
import { repo } from "./lib/repo";
import { IMPORT_REASON_MAX, importFailureList, shortReason, useField } from "./store";
import { dismissAll, getToasts, notify } from "./toasts";

const importLocalPdfs = repo.importLocalPdfs as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  dismissAll();
  importLocalPdfs.mockReset();
  useField.setState({
    selectedDomainId: "d-1",
    mode: "field",
    search: "",
    effectiveProvider: null,
    mineru: { ...useField.getState().mineru, configured: false },
  } as never);
});

describe("import failure reasons are shortened", () => {
  it("keeps short reasons, cuts long ones to IMPORT_REASON_MAX with an ellipsis", () => {
    expect(shortReason("文件损坏")).toBe("文件损坏");
    const long = "无法读取 /Users/someone/" + "很长的路径/".repeat(20) + "a.pdf";
    const cut = shortReason(long);
    expect([...cut].length).toBe(IMPORT_REASON_MAX);
    expect(cut.endsWith("…")).toBe(true);
    expect(importFailureList([{ name: "a.pdf", message: long }])).toBe(`a.pdf（${cut}）`);
  });
});

describe("retry failed imports", () => {
  it("the toast's retry re-imports only the failed paths", async () => {
    importLocalPdfs.mockImplementation(async (_d: string, [p]: string[]) => {
      if (p.endsWith("bad.pdf")) throw new Error("磁盘已满");
      return { created: [{ id: p }], skipped: [] };
    });
    await useField.getState().importPdfs(["/x/ok.pdf", "/x/bad.pdf"]);
    const toast = getToasts().find((t) => t.tone === "error")!;
    expect(toast.text).toContain("bad.pdf（磁盘已满）");
    expect(toast.action?.label).toBe("重试");
    expect(toast.durationMs).toBe(0);

    importLocalPdfs.mockClear();
    importLocalPdfs.mockImplementation(async (_d: string, [p]: string[]) => ({ created: [{ id: p }], skipped: [] }));
    render(createElement(Toasts));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await vi.waitFor(() => expect(importLocalPdfs).toHaveBeenCalledTimes(1));
    expect(importLocalPdfs).toHaveBeenCalledWith("d-1", ["/x/bad.pdf"]);
    expect(getToasts().some((t) => t.text.includes("磁盘已满"))).toBe(false);
  });

  it("several failures label the button with the count", async () => {
    importLocalPdfs.mockImplementation(async () => {
      throw new Error("坏文件");
    });
    await useField.getState().importPdfs(["/x/a.pdf", "/x/b.pdf"]);
    expect(getToasts().find((t) => t.tone === "error")?.action?.label).toBe("重试这 2 篇");
  });

  it("toasts without an action keep their normal auto-dismiss duration", () => {
    notify("error", "普通错误");
    expect(getToasts().find((t) => t.text === "普通错误")?.durationMs).toBeUndefined();
  });
});
