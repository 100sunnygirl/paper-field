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
import { resetImportFailures } from "./lib/importFailures";
import { IMPORT_REASON_MAX, importFailureList, shortReason, useField } from "./store";
import { dismissAll, getToasts, notify } from "./toasts";

const importLocalPdfs = repo.importLocalPdfs as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  dismissAll();
  importLocalPdfs.mockReset();
  resetImportFailures();
  useField.setState({
    selectedDomainId: "d-1",
    mode: "field",
    search: "",
    effectiveProvider: null,
    mineru: { ...useField.getState().mineru, configured: false },
    importFailures: [],
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

  it("retry imports into the domain the failed import targeted, even after switching domains", async () => {
    importLocalPdfs.mockImplementation(async () => {
      throw new Error("坏文件");
    });
    await useField.getState().importPdfs(["/x/bad.pdf"]);
    useField.setState({ selectedDomainId: "d-2" } as never);
    importLocalPdfs.mockReset();
    importLocalPdfs.mockImplementation(async (_d: string, [p]: string[]) => ({ created: [{ id: p }], skipped: [] }));
    render(createElement(Toasts));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await vi.waitFor(() => expect(importLocalPdfs).toHaveBeenCalledTimes(1));
    expect(importLocalPdfs).toHaveBeenCalledWith("d-1", ["/x/bad.pdf"]);
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

describe("import failure list persistence", () => {
  it("导入失败的文件进入持久化清单（含目标领域与截断原因），成功的不进", async () => {
    importLocalPdfs.mockImplementation(async (_d: string, [p]: string[]) => {
      if (p.endsWith("bad.pdf")) throw new Error("磁盘已满");
      return { created: [{ id: p }], skipped: [] };
    });
    await useField.getState().importPdfs(["/x/ok.pdf", "/x/bad.pdf"]);
    const failures = useField.getState().importFailures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ path: "/x/bad.pdf", name: "bad.pdf", domainId: "d-1", message: "磁盘已满" });
  });

  it("确认重复（skipped）也算落定并移出清单", async () => {
    importLocalPdfs.mockImplementation(async (_d: string, [p]: string[]) => ({ created: [], skipped: [p] }));
    await useField.getState().importPdfs(["/x/dup.pdf"]);
    expect(useField.getState().importFailures).toEqual([]);
  });

  it("重试成功后清单自动清空；再失败则更新原因", async () => {
    importLocalPdfs.mockImplementation(async () => {
      throw new Error("磁盘已满");
    });
    await useField.getState().importPdfs(["/x/bad.pdf"]);
    expect(useField.getState().importFailures).toHaveLength(1);

    importLocalPdfs.mockImplementation(async (_d: string, [p]: string[]) => ({ created: [{ id: p }], skipped: [] }));
    await useField.getState().retryImportFailures();
    expect(useField.getState().importFailures).toEqual([]);

    importLocalPdfs.mockImplementation(async () => {
      throw new Error("另一个原因");
    });
    await useField.getState().importPdfs(["/x/bad.pdf"]);
    expect(useField.getState().importFailures[0]?.message).toBe("另一个原因");
  });

  it("retryImportFailures 按原目标领域分组重跑，切过领域也不改道", async () => {
    importLocalPdfs.mockImplementation(async () => {
      throw new Error("坏文件");
    });
    await useField.getState().importPdfs(["/x/a.pdf"]); // 目标 d-1
    await useField.getState().importPdfs(["/y/b.pdf"], undefined, "d-2");
    useField.setState({ selectedDomainId: "d-9" } as never);

    importLocalPdfs.mockClear();
    importLocalPdfs.mockImplementation(async (_d: string, [p]: string[]) => ({ created: [{ id: p }], skipped: [] }));
    await useField.getState().retryImportFailures();
    expect(importLocalPdfs).toHaveBeenCalledWith("d-1", ["/x/a.pdf"]);
    expect(importLocalPdfs).toHaveBeenCalledWith("d-2", ["/y/b.pdf"]);
    expect(importLocalPdfs).not.toHaveBeenCalledWith("d-9", expect.anything());
    expect(useField.getState().importFailures).toEqual([]);
  });

  it("清单为空时重试给提示不报错", async () => {
    await useField.getState().retryImportFailures();
    expect(getToasts().some((t) => t.text.includes("没有待重试的导入失败文件"))).toBe(true);
  });
});

describe("importPdfsPerFile · 逐文件目标领域", () => {
  it("每个文件按自己的目标领域入库，结果按文件计数", async () => {
    importLocalPdfs.mockImplementation(async (d: string, [p]: string[]) => ({ created: [{ id: `${d}:${p}` }], skipped: [] }));
    const outcome = await useField.getState().importPdfsPerFile([
      { path: "/x/a.pdf", domainId: "d-1" },
      { path: "/y/b.pdf", domainId: "d-2" },
    ]);
    expect(importLocalPdfs).toHaveBeenCalledWith("d-1", ["/x/a.pdf"]);
    expect(importLocalPdfs).toHaveBeenCalledWith("d-2", ["/y/b.pdf"]);
    expect(outcome).toMatchObject({ created: 2, skipped: 0 });
    expect(outcome.failed).toEqual([]);
  });

  it("同一路径出现两次只导一次（按首次目标领域）", async () => {
    importLocalPdfs.mockImplementation(async (_d: string, [p]: string[]) => ({ created: [{ id: p }], skipped: [] }));
    await useField.getState().importPdfsPerFile([
      { path: "/x/a.pdf", domainId: "d-1" },
      { path: "/x/a.pdf", domainId: "d-2" },
    ]);
    expect(importLocalPdfs).toHaveBeenCalledTimes(1);
    expect(importLocalPdfs).toHaveBeenCalledWith("d-1", ["/x/a.pdf"]);
  });

  it("没带目标领域的条目按失败记账（含原因），不影响其余文件", async () => {
    importLocalPdfs.mockImplementation(async (_d: string, [p]: string[]) => ({ created: [{ id: p }], skipped: [] }));
    const outcome = await useField.getState().importPdfsPerFile([
      { path: "/x/ok.pdf", domainId: "d-1" },
      { path: "/x/orphan.pdf", domainId: "" },
    ]);
    expect(importLocalPdfs).toHaveBeenCalledTimes(1);
    expect(outcome.created).toBe(1);
    expect(outcome.failed).toEqual([
      { name: "orphan.pdf", path: "/x/orphan.pdf", domainId: "", message: "未指定目标领域" },
    ]);
  });

  it("逐文件失败按各自目标领域进入待重试清单，重试不改道", async () => {
    importLocalPdfs.mockImplementation(async (d: string) => {
      if (d === "d-2") throw new Error("坏文件");
      return { created: [{ id: "ok" }], skipped: [] };
    });
    await useField.getState().importPdfsPerFile([
      { path: "/x/a.pdf", domainId: "d-1" },
      { path: "/y/b.pdf", domainId: "d-2" },
    ]);
    const failures = useField.getState().importFailures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ path: "/y/b.pdf", domainId: "d-2" });

    importLocalPdfs.mockClear();
    importLocalPdfs.mockImplementation(async (_d: string, [p]: string[]) => ({ created: [{ id: p }], skipped: [] }));
    await useField.getState().retryImportFailures();
    expect(importLocalPdfs).toHaveBeenCalledWith("d-2", ["/y/b.pdf"]);
    expect(useField.getState().importFailures).toEqual([]);
  });
});
