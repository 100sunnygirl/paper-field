// Tester repro (FeatureIdeator round2 #1): setSearch has no debounce and no stale-result guard.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperListItem } from "./lib/types";

vi.mock("./lib/repo", () => ({
  repo: {
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    getPaper: vi.fn(async () => null),
  },
}));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));

import { repo } from "./lib/repo";
import { useField } from "./store";

const item = (id: string) => ({ id, domainId: "d-1", title: id }) as unknown as PaperListItem;
const listPapers = repo.listPapers as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  listPapers.mockReset();
  useField.setState({ selectedDomainId: "d-1", mode: "field", search: "", papers: [] } as never);
});

describe("tester: search race / debounce", () => {
  it("a slow older query must not overwrite a newer result", async () => {
    listPapers.mockImplementation(async (_d: string, q: string) => {
      if (q === "t") { await new Promise((r) => setTimeout(r, 60)); return [item("old-t")]; }
      return [item(`new-${q}`)];
    });
    const first = useField.getState().setSearch("t");
    const second = useField.getState().setSearch("tr");
    await Promise.all([first, second]);
    expect(useField.getState().search).toBe("tr");
    expect(useField.getState().papers.map((p) => p.id)).toEqual(["new-tr"]);
  });

  it("typing 'transformer' quickly issues at most 2 list queries", async () => {
    listPapers.mockImplementation(async () => []);
    const word = "transformer";
    const calls: Promise<void>[] = [];
    for (let i = 1; i <= word.length; i++) calls.push(useField.getState().setSearch(word.slice(0, i)));
    await Promise.all(calls);
    await new Promise((r) => setTimeout(r, 400)); // allow a 200-300ms debounce to fire
    expect(listPapers.mock.calls.length).toBeLessThanOrEqual(2);
    expect(listPapers.mock.calls.at(-1)?.[1]).toBe(word);
  });
});
