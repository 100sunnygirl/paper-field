import { describe, expect, it, vi } from "vitest";

vi.mock("./lib/repo", () => ({ repo: {} }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));

import { importFailureList } from "./store";

const f = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `bad${i + 1}.pdf`, message: `原因${i + 1}` }));

describe("batch import failure summary", () => {
  it("names every failed file, not only the first", () => {
    expect(importFailureList(f(3))).toBe("bad1.pdf（原因1）、bad2.pdf（原因2）、bad3.pdf（原因3）");
  });

  it("caps the toast at 5 and counts the rest", () => {
    const text = importFailureList(f(8));
    expect(text).toContain("bad5.pdf（原因5）");
    expect(text).not.toContain("bad6.pdf");
    expect(text.endsWith("等，另有 3 篇")).toBe(true);
  });
});
