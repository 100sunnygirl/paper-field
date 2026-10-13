import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("./util", async (orig) => ({ ...(await orig<typeof import("./util")>()), isTauri: () => true }));

import { verifyReachable } from "./lookup";

describe("verifyReachable keeps links unless the server says they are gone", () => {
  beforeEach(() => invoke.mockReset());

  it("passes through the three outcomes from verify_url", async () => {
    for (const r of ["reachable", "unreachable", "unknown"] as const) {
      invoke.mockResolvedValueOnce(r);
      expect(await verifyReachable("https://example.org/x")).toBe(r);
    }
  });

  it("treats an invoke failure (timeout, DNS, IPC) as unknown, never unreachable", async () => {
    invoke.mockRejectedValueOnce(new Error("timed out"));
    expect(await verifyReachable("https://example.org/x")).toBe("unknown");
  });

  it("calls a malformed URL unreachable without asking the backend", async () => {
    expect(await verifyReachable("javascript:alert(1)")).toBe("unreachable");
    expect(invoke).not.toHaveBeenCalled();
  });
});
