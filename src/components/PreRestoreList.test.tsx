import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
const ask = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: (...a: unknown[]) => ask(...a), open: vi.fn() }));
vi.mock("../lib/util", async (orig) => ({ ...(await orig<object>()), isTauri: () => true }));

import { PreRestoreList } from "./PreRestoreList";
import { deleteConfirmText, type PreDir } from "../lib/preRestore";

const a: PreDir = { name: "pre-restore-200", path: "/d/pre-restore-200", createdMs: 200, bytes: 4096, hasDb: true, orphans: false };
const b: PreDir = { name: "pre-restore-100", path: "/d/pre-restore-100", createdMs: 100, bytes: 2048, hasDb: false, orphans: false };
const orphan: PreDir = { name: ".restore-orphans-300", path: "/d/.restore-orphans-300", createdMs: 300, bytes: 10, hasDb: false, orphans: true };

beforeEach(() => {
  invoke.mockReset();
  ask.mockReset();
});

function listing(dirs: PreDir[], busy = false) {
  invoke.mockImplementation(async (cmd: string) => (cmd === "restore_list_pre" ? { dirs, busy } : undefined));
}

describe("PreRestoreList", () => {
  it("cancel in the confirm does not delete", async () => {
    listing([a, b]);
    ask.mockResolvedValue(false);
    render(<PreRestoreList />);
    fireEvent.click(await screen.findByLabelText("删除 pre-restore-100"));
    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(invoke).not.toHaveBeenCalledWith("restore_delete_pre", expect.anything());
  });

  it("confirm deletes then refreshes the list", async () => {
    listing([a, b]);
    ask.mockResolvedValue(true);
    render(<PreRestoreList />);
    expect(await screen.findByText(/最近一次/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("删除 pre-restore-100"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("restore_delete_pre", { name: "pre-restore-100" }));
    await waitFor(() => expect(invoke.mock.calls.filter((c) => c[0] === "restore_list_pre").length).toBe(2));
  });

  it("disables delete while a restore is pending", async () => {
    listing([a], true);
    render(<PreRestoreList />);
    expect((await screen.findByLabelText("删除 pre-restore-200")).hasAttribute("disabled")).toBe(true);
  });

  it("warns when deleting the only rollback copy", () => {
    expect(deleteConfirmText(a, [a, b])).toContain("这是唯一一份可回滚的原数据");
    expect(deleteConfirmText(b, [a, b])).not.toContain("唯一一份");
    expect(deleteConfirmText(b, [a, b])).toContain("此操作不可撤销");
  });

  it("labels orphan sidecars and keeps the newest marker on rollback copies", async () => {
    listing([orphan, a, b]);
    render(<PreRestoreList />);
    expect(await screen.findByText(/临时文件/)).toBeTruthy();
    const rows = screen.getAllByRole("listitem");
    expect(rows[0].textContent).not.toContain("最近一次");
    expect(rows[1].textContent).toContain("最近一次");
    expect(deleteConfirmText(orphan, [orphan, a, b])).toContain("恢复时移开的临时文件");
    expect(deleteConfirmText(orphan, [orphan, a, b])).not.toContain("唯一一份");
  });
});
