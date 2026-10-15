// @vitest-environment node
// Tester repro: search must treat % and _ literally (FeatureIdeator #2, repo.ts:383/398).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestEngine, type TestEngineHandle } from "../test/helpers";
import type { SqlEngine } from "./engine";
import { repo } from "./repo";

const holder = vi.hoisted(() => ({ engine: null as SqlEngine | null }));
vi.mock("./engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine")>();
  return { ...actual, getEngine: () => Promise.resolve(holder.engine!) };
});

let handle: TestEngineHandle;
let domainId: string;
beforeEach(async () => {
  handle = await makeTestEngine();
  holder.engine = handle.engine;
  for (const t of ["app_meta", "notes", "paper_authors", "paper_parse", "llm_jobs", "papers", "authors", "domains"]) {
    await handle.engine.execute(`DELETE FROM ${t}`);
  }
  domainId = (await repo.createDomain({ name: "d", code: "LK-01", summary: "" })).id;
  for (const title of ["Gain 50% faster", "Gain 500 faster", "a_b study", "axb study"]) {
    await repo.createPaper({ domainId, title });
  }
});
afterEach(() => handle.close());

const titles = (rows: { title: string }[]) => rows.map((r) => r.title).sort();

describe("tester: LIKE wildcards are literal", () => {
  it("listPapers '50%' matches only the literal percent", async () => {
    expect(titles(await repo.listPapers(domainId, "50%"))).toEqual(["Gain 50% faster"]);
  });
  it("listPapers 'a_b' does not match 'axb'", async () => {
    expect(titles(await repo.listPapers(domainId, "a_b"))).toEqual(["a_b study"]);
  });
  it("searchAll '50%' matches only the literal percent", async () => {
    expect(titles(await repo.searchAll("50%"))).toEqual(["Gain 50% faster"]);
  });
  it("searchAll 'a_b' does not match 'axb'", async () => {
    expect(titles(await repo.searchAll("a_b"))).toEqual(["a_b study"]);
  });
  it("backslash in query is literal too", async () => {
    await repo.createPaper({ domainId, title: "C:\\path note" });
    expect(titles(await repo.searchAll("C:\\path"))).toEqual(["C:\\path note"]);
  });
});
