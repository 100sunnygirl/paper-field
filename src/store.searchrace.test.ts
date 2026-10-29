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
const getPaper = repo.getPaper as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  listPapers.mockReset();
  getPaper.mockReset();
  getPaper.mockResolvedValue(null);
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

  it("selectDomain clears the query without setSearch and lands on the first row", async () => {
    listPapers.mockResolvedValue([item("first"), item("second")]);
    getPaper.mockImplementation(async (id: string) => ({ id, domainId: "d-2", title: id }));
    const setSearch = vi.spyOn(useField.getState(), "setSearch");
    useField.setState({ search: "clip" } as never);
    await useField.getState().selectDomain("d-2");
    expect(setSearch).not.toHaveBeenCalled();
    expect(useField.getState().search).toBe("");
    expect(useField.getState().selectedDomainId).toBe("d-2");
    expect(useField.getState().selectedPaperId).toBe("first");
    expect(listPapers).toHaveBeenCalledWith("d-2", "");
  });

  it("selectDomain can land on a paper and settles the search that was still waiting", async () => {
    listPapers.mockResolvedValue([item("first"), item("second")]);
    getPaper.mockImplementation(async (id: string) => ({ id, domainId: "d-2", title: id }));
    const pending = useField.getState().setSearch("transformer");
    await useField.getState().selectDomain("d-2", "second");
    await pending;
    expect(useField.getState().search).toBe("");
    expect(useField.getState().selectedPaperId).toBe("second");
    expect(listPapers.mock.calls.map((call) => call[1])).not.toContain("transformer");
  });

  it("selectPaper leaves the search query alone", async () => {
    getPaper.mockResolvedValue({ id: "p1", domainId: "d-1", title: "t" });
    useField.setState({ search: "clip" } as never);
    await useField.getState().selectPaper("p1");
    expect(useField.getState().search).toBe("clip");
    expect(useField.getState().selectedPaperId).toBe("p1");
  });

  it("a job with no domain id lands through the paper's own domain", async () => {
    getPaper.mockImplementation(async (id: string) => ({ id, domainId: "d-9", title: id }));
    listPapers.mockImplementation(async (domainId: string) => (domainId === "d-9" ? [item("p9")] : []));
    useField.setState({ search: "clip" } as never);
    await useField.getState().landOnPaper("p9", null);
    expect(useField.getState().selectedDomainId).toBe("d-9");
    expect(useField.getState().selectedPaperId).toBe("p9");
    expect(useField.getState().search).toBe("");
    expect(listPapers).toHaveBeenCalledWith("d-9", "");
  });
});
