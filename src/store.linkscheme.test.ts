// Tester repro, round3: scheme completion + clear-search (Reviewer's 3 cases + Improver's 3 points).
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ paper: null as any, verdict: {} as Record<string, string> }));

vi.mock("./lib/repo", () => ({
  repo: {
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    getPaper: vi.fn(async () => state.paper),
    createJob: vi.fn(async () => ({ id: "j1" })),
    updateJob: vi.fn(async () => true),
    jobStatus: vi.fn(async () => "running"),
    applyPreparedMeta: vi.fn(async () => undefined),
    updatePaper: vi.fn(async () => undefined),
    replaceLinkIf: vi.fn(async () => true),
  },
}));
vi.mock("./lib/lookup", async (orig) => ({
  ...(await orig<typeof import("./lib/lookup")>()),
  lookupPaper: vi.fn(async () => ({ meta: null, notices: [], openalexRemainingUsd: null, openalexLimitUsd: null })),
  verifyReachable: vi.fn(async (u: string) => state.verdict[u] ?? "unknown"),
}));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));

import { repo } from "./lib/repo";
import { useField } from "./store";

const replaceLinkIf = repo.replaceLinkIf as unknown as ReturnType<typeof vi.fn>;
const listPapers = repo.listPapers as unknown as ReturnType<typeof vi.fn>;

function paperWith(codeUrl: string | null, projectPage: string | null = null) {
  state.paper = { id: "p1", domainId: "d-1", title: "t", codeUrl, projectPage, fieldSources: {}, metaRev: 0 };
}
/** Final stored value for key after runRefreshLinks (undefined = untouched). */
async function storedAfterRefresh(key: "codeUrl" | "projectPage") {
  replaceLinkIf.mockClear();
  await useField.getState().runRefreshLinks("p1");
  // 条件写入：(paperId, key, 检查时的值, 新值)
  const call = replaceLinkIf.mock.calls.filter((c) => c[1] === key).at(-1);
  return call ? call[3] : "<kept>";
}

beforeEach(() => {
  state.verdict = {};
  useField.setState({ selectedDomainId: "d-1", mode: "field", search: "", papers: [] } as never);
});

describe("tester r3: scheme completion", () => {
  it("R1 schemeless junk 'v1.2' + unknown verdict is dropped, not saved as https://v1.2", async () => {
    paperWith("v1.2");
    expect(await storedAfterRefresh("codeUrl")).toBeNull();
  });
  it("R1b 'README.md' + unknown is dropped", async () => {
    paperWith("README.md");
    expect(await storedAfterRefresh("codeUrl")).toBeNull();
  });
  it("R2 'github.com/x' reachable is stored as https://github.com/x", async () => {
    paperWith("github.com/x");
    state.verdict["https://github.com/x"] = "reachable";
    expect(await storedAfterRefresh("codeUrl")).toBe("https://github.com/x");
  });
  it("R3 already-schemed link with unknown verdict is kept untouched", async () => {
    paperWith("https://example.org/repo");
    expect(await storedAfterRefresh("codeUrl")).toBe("<kept>");
  });
  it("R3b already-schemed link with 404 (unreachable) is cleared", async () => {
    paperWith("https://example.org/gone");
    state.verdict["https://example.org/gone"] = "unreachable";
    expect(await storedAfterRefresh("codeUrl")).toBeNull();
  });
  it("R4 schemeless 'localhost:3000' is never stored as a link", async () => {
    paperWith("localhost:3000");
    expect(await storedAfterRefresh("codeUrl")).toBeNull();
  });
  it("R5 schemeless link unreachable is dropped", async () => {
    paperWith("github.com/none");
    state.verdict["https://github.com/none"] = "unreachable";
    expect(await storedAfterRefresh("codeUrl")).toBeNull();
  });
});

describe("tester r3: clearing search", () => {
  it("C1 clearing the box queries within 50ms (no 250ms debounce)", async () => {
    listPapers.mockReset();
    listPapers.mockImplementation(async () => []);
    void useField.getState().setSearch("");
    await new Promise((r) => setTimeout(r, 50));
    expect(listPapers).toHaveBeenCalled();
    expect(listPapers.mock.calls.at(-1)?.[1]).toBe("");
  });
  it("C2 type then clear immediately ends on the full list", async () => {
    listPapers.mockReset();
    listPapers.mockImplementation(async (_d: string, q: string) => {
      if (q) await new Promise((r) => setTimeout(r, 30));
      return [{ id: q ? `hit-${q}` : "all" }];
    });
    const a = useField.getState().setSearch("trans");
    const b = useField.getState().setSearch("");
    await Promise.all([a, b]);
    await new Promise((r) => setTimeout(r, 400));
    expect(useField.getState().search).toBe("");
    expect(useField.getState().papers.map((p: any) => p.id)).toEqual(["all"]);
  });
});
