import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { MigrationNotices } from "./MigrationNotices";

beforeEach(() => {
  invoke.mockReset();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("MigrationNotices", () => {
  it("shows config and data as two lines, each with its old path", async () => {
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue([
      {
        kind: "config",
        oldPath: "/cfg/old/com.paperfield.app",
        newPath: "/cfg/new/com.paperfield.notes",
      },
      {
        kind: "data",
        oldPath: "/data/old/com.paperfield.app",
        newPath: "/data/new/com.paperfield.notes",
      },
    ]);

    render(<MigrationNotices />);
    const lines = await screen.findAllByRole("status");
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain("配置");
    expect(lines[0].textContent).toContain("/cfg/old/com.paperfield.app");
    expect(lines[0].textContent).not.toContain("/data/old/com.paperfield.app");
    expect(lines[1].textContent).toContain("数据");
    expect(lines[1].textContent).toContain("/data/old/com.paperfield.app");
    expect(lines[1].textContent).not.toContain("/cfg/old/com.paperfield.app");
    expect(invoke).toHaveBeenCalledWith("appdir_migration_notices");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("local data is its own line and does not offer an overwrite", async () => {
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue([
      {
        kind: "local",
        oldPath: "/local/old/com.paperfield.app",
        newPath: "/local/new/com.paperfield.notes",
      },
    ]);
    render(<MigrationNotices />);
    const line = await screen.findByRole("status");
    expect(line.textContent).toContain("本机数据");
    expect(line.textContent).toContain("/local/old/com.paperfield.app");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
