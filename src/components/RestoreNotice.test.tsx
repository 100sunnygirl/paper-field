import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
const relaunch = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunch() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

import { RestoreNotice } from "./RestoreNotice";

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  relaunch.mockReset().mockResolvedValue(undefined);
});

describe("RestoreNotice", () => {
  it("renders nothing when there is no pending restore", () => {
    const { container } = render(<RestoreNotice initial={{ kind: "none" }} />);
    expect(container.innerHTML).toBe("");
  });

  it("stuck: abandon calls restore_abandon then relaunches", async () => {
    render(<RestoreNotice initial={{ kind: "stuck", pre: "/d/pre-restore-1", dbAvailable: true }} />);
    expect(screen.getByRole("alert").textContent).toContain("/d/pre-restore-1");
    fireEvent.click(screen.getByText("放弃这次恢复"));
    await waitFor(() => expect(relaunch).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("restore_abandon");
  });

  it("pendingConfirm: apply confirms then relaunches", async () => {
    render(<RestoreNotice initial={{ kind: "pendingConfirm" }} />);
    fireEvent.click(screen.getByText("应用"));
    await waitFor(() => expect(relaunch).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("restore_confirm_pending");
  });

  it("rolledBack can be dismissed", () => {
    render(<RestoreNotice initial={{ kind: "rolledBack", pre: "/d/pre-restore-2" }} />);
    fireEvent.click(screen.getByText("知道了"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
