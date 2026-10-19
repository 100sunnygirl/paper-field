import { describe, expect, it } from "vitest";
import { decide, planPreparedMeta, type MergePrev } from "./mergeMeta";
import type { FieldSource, MetaField, PreparedMeta } from "./types";

type Prev = FieldSource | "empty";
type Write = "api" | "api-refresh" | "api-overwrite" | "llm" | "llm-overwrite";

// 决策表本身就是规格：逐格断言。
const TABLE: Record<Prev, Record<Write, boolean>> = {
  empty: { api: true, "api-refresh": true, "api-overwrite": true, llm: true, "llm-overwrite": true },
  file: { api: true, "api-refresh": true, "api-overwrite": true, llm: true, "llm-overwrite": true },
  llm: { api: true, "api-refresh": true, "api-overwrite": true, llm: false, "llm-overwrite": true },
  api: { api: false, "api-refresh": true, "api-overwrite": false, llm: false, "llm-overwrite": false },
  user: { api: false, "api-refresh": false, "api-overwrite": true, llm: false, "llm-overwrite": true },
};

function args(write: Write) {
  const incoming = write.startsWith("api") ? ("api" as const) : ("llm" as const);
  return { incoming, mode: { overwrite: write.endsWith("overwrite"), replaceApi: write === "api-refresh" } };
}

describe("来源决策表", () => {
  for (const [prev, row] of Object.entries(TABLE) as Array<[Prev, Record<Write, boolean>]>) {
    for (const [write, expected] of Object.entries(row) as Array<[Write, boolean]>) {
      it(`${prev} ← ${write}：${expected ? "写" : "保留"}`, () => {
        const { incoming, mode } = args(write);
        const source = prev === "empty" ? undefined : prev;
        expect(decide("title", source, prev !== "empty", incoming, mode, false)).toBe(expected);
      });
    }
  }

  it("模型永远不写标识符（DOI / arXiv / 年份），哪怕是空白或选了覆盖", () => {
    for (const field of ["doi", "arxivId", "year"] as MetaField[]) {
      expect(decide(field, undefined, false, "llm", { overwrite: true, replaceApi: false }, false)).toBe(false);
      expect(decide(field, undefined, false, "api", { overwrite: false, replaceApi: false }, false)).toBe(true);
    }
  });

  it("请求发出后用户又改过：手动值在任何模式下都保留", () => {
    for (const write of ["api", "api-refresh", "api-overwrite", "llm", "llm-overwrite"] as Write[]) {
      const { incoming, mode } = args(write);
      expect(decide("venue", "user", true, incoming, mode, true)).toBe(false);
    }
  });
});

const PREV: MergePrev = {
  title: "attention",
  titleZh: null,
  abstract: "",
  year: null,
  venue: "手填期刊",
  doi: null,
  arxivId: null,
  pdfUrl: null,
  codeUrl: null,
  codeOpenSource: "unknown",
  projectPage: null,
  tags: [],
  labs: [],
  fieldSources: { title: "file", venue: "user" },
  fieldProviders: {},
  metaRev: 1,
  authorCount: 0,
};

function meta(patch: Partial<PreparedMeta> = {}): PreparedMeta {
  return {
    title: "",
    titleZh: null,
    abstract: "",
    year: null,
    venue: null,
    doi: null,
    arxivId: null,
    authors: [],
    labs: [],
    codeOpenSource: "unknown",
    codeURL: null,
    projectPage: null,
    pdfURL: null,
    tags: [],
    ...patch,
  };
}

describe("planPreparedMeta", () => {
  it("值没变时不改来源、不进 changed", () => {
    const prev = { ...PREV, title: "Attention", fieldSources: { title: "api" as const }, fieldProviders: { title: "crossref" } };
    const plan = planPreparedMeta(prev, meta({ title: "Attention", fieldProviders: { title: "openalex" } }), false, "api", 1, true);
    expect(plan.fieldSources.title).toBe("api");
    expect(plan.fieldProviders.title).toBe("crossref");
    expect(plan.changed).not.toContain("title");
  });

  it("模型没给标题就不动标题来源（不再用当前标题兜底）", () => {
    const prev = { ...PREV, title: "我的标题", fieldSources: { title: "user" as const } };
    const plan = planPreparedMeta(prev, meta({ titleZh: "中文" }), true, "llm");
    expect(plan.fieldSources.title).toBe("user");
    expect(plan.changed).toEqual(["titleZh"]);
  });

  it("文件名标题被文献库替换并记录具体库名", () => {
    const plan = planPreparedMeta(PREV, meta({ title: "Attention Is All You Need", fieldProviders: { title: "arxiv" } }), false, "api", 1);
    expect(plan.title).toBe("Attention Is All You Need");
    expect(plan.fieldSources.title).toBe("api");
    expect(plan.fieldProviders.title).toBe("arxiv");
    expect(plan.venue).toBe("手填期刊");
  });

  it("性质：任意写入序列之后，user 字段只会被确认后的覆盖改动", () => {
    const writes: Write[] = ["api", "api-refresh", "llm", "api", "llm", "api-refresh"];
    let prev = { ...PREV };
    for (const write of writes) {
      const { incoming, mode } = args(write);
      const plan = planPreparedMeta(prev, meta({ title: `t-${write}`, venue: `v-${write}`, abstract: "a" }), mode.overwrite, incoming, prev.metaRev, mode.replaceApi);
      prev = { ...prev, ...plan, fieldSources: plan.fieldSources, fieldProviders: plan.fieldProviders };
      expect(prev.venue).toBe("手填期刊");
      expect(prev.fieldSources.venue).toBe("user");
    }
  });
});
