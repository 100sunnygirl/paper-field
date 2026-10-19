// 第 1 轮模块检测 · 日志系统：独立于 logger.test.ts 的补充检测用例。
// 覆盖：启动回读与并发写入的交互（数据丢失风险）、落盘条数上限、
// detail 序列化、落盘降级后 clear() 的行为、缓冲上限的 seq 单调性。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeStore = vi.hoisted(() => ({
  set: vi.fn(async (_key: string, _value: unknown) => undefined),
  get: vi.fn(async (_key?: string) => undefined as unknown),
  clear: vi.fn(async () => undefined),
  save: vi.fn(async () => undefined),
}));
// 落盘改走 Rust 命令 app_log_*：映射到内存假 store，沿用原有断言口径
// （write = set("entries") + save，clear = clear + save，read = get("entries")）。
const invokeMock = vi.hoisted(() =>
  vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (cmd === "app_log_read") return fakeStore.get("entries");
    if (cmd === "app_log_write") {
      await fakeStore.set("entries", args?.entries);
      return fakeStore.save();
    }
    if (cmd === "app_log_clear") {
      await fakeStore.clear();
      return fakeStore.save();
    }
    return undefined;
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

vi.mock("./util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./util")>();
  return { ...actual, isTauri: vi.fn(() => false) };
});

import { isTauri } from "./util";
import { LOG_BUFFER_LIMIT, LOG_PERSIST_LIMIT, type LogEntry } from "./logger";

/** 重置模块图后重新加载 logger：用例间互不污染。 */
async function freshLogger() {
  vi.resetModules();
  return import("./logger");
}

/** 静音控制台镜像，并可在断言中读取调用记录。 */
function quietConsole() {
  const spies = (["debug", "log", "warn", "error"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  return spies;
}

describe("检测 · Tauri 落盘", () => {
  let quiet: ReturnType<typeof quietConsole>;
  beforeEach(() => {
    quiet = quietConsole();
    vi.useFakeTimers();
    vi.mocked(isTauri).mockReturnValue(true);
    fakeStore.set.mockReset().mockResolvedValue(undefined);
    fakeStore.save.mockReset().mockResolvedValue(undefined);
    fakeStore.clear.mockReset().mockResolvedValue(undefined);
    fakeStore.get.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    quiet.forEach((spy) => spy.mockRestore());
    vi.useRealTimers();
  });

  it("落盘条数上限 200：写 205 条 info 后只落盘最新 200 条", async () => {
    const fresh = await freshLogger();
    fakeStore.set.mockClear();
    for (let i = 1; i <= LOG_PERSIST_LIMIT + 5; i += 1) fresh.log.info("app", `I-${i}`);
    await vi.advanceTimersByTimeAsync(3100);
    expect(fakeStore.set).toHaveBeenCalledTimes(1);
    const value = fakeStore.set.mock.calls[0]![1] as LogEntry[];
    expect(value).toHaveLength(LOG_PERSIST_LIMIT);
    expect(value[0]!.message).toBe("I-6");
    expect(value[value.length - 1]!.message).toBe(`I-${LOG_PERSIST_LIMIT + 5}`);
  });

  it("启动回读完成前写入的日志条目不被回读覆盖（历史尾部在前、启动早期条目在后）", async () => {
    // 用受控 pending promise 把回读卡在半路，模拟 IPC 尚未完成时的启动窗口。
    let release!: (value: unknown) => void;
    fakeStore.get.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const fresh = await freshLogger();
    // 推进微任务直到 bootstrap 链走到 store.get（promise 挂起，链停在半路）。
    await vi.advanceTimersByTimeAsync(0);
    expect(typeof release).toBe("function");
    fresh.log.info("engine", "启动早期条目");
    release([
      { seq: 7, ts: "2026-10-01T00:00:00.000Z", level: "error", scope: "ui", message: "上次崩溃" },
      { seq: 9, ts: "2026-10-01T00:00:01.000Z", level: "info", scope: "app", message: "上次尾部" },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    const messages = fresh.getEntries().map((e) => e.message);
    expect(messages).toEqual(["上次崩溃", "上次尾部", "启动早期条目"]);
    // 序号必须接续：新条目 seq 大于回读的最大 seq，避免后续 key 冲突。
    expect(fresh.getEntries().at(-1)!.seq).toBeGreaterThan(9);
  });

  it("回读满额 500 条时合并：裁掉历史头部，本会话条目保留在尾且 seq 全程唯一", async () => {
    let release!: (value: unknown) => void;
    fakeStore.get.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const fresh = await freshLogger();
    await vi.advanceTimersByTimeAsync(0);
    fresh.log.info("app", "本会话-甲");
    fresh.log.info("app", "本会话-乙");
    release(
      Array.from({ length: LOG_BUFFER_LIMIT }, (_, i) => ({
        seq: i + 1,
        ts: "2026-10-01T00:00:00.000Z",
        level: "info",
        scope: "app",
        message: `H-${i + 1}`,
      })),
    );
    await vi.advanceTimersByTimeAsync(0);
    const entries = fresh.getEntries();
    expect(entries).toHaveLength(LOG_BUFFER_LIMIT);
    // 历史头部两条被裁（容量上限），本会话条目在尾
    expect(entries[0]!.message).toBe("H-3");
    expect(entries.slice(-2).map((e) => e.message)).toEqual(["本会话-甲", "本会话-乙"]);
    // seq 唯一（React key 安全）且合并后续写无缝衔接
    expect(new Set(entries.map((e) => e.seq)).size).toBe(LOG_BUFFER_LIMIT);
    fresh.log.info("app", "合并后新条目");
    const last = fresh.getEntries().at(-1)!;
    expect(last.seq).toBeGreaterThan(entries.at(-2)!.seq);
  });

  it("合并落地通知订阅者并递增版本号（UI 需要重渲染）", async () => {
    fakeStore.get.mockResolvedValue([
      { seq: 1, ts: "2026-10-01T00:00:00.000Z", level: "warn", scope: "app", message: "上次一条" },
    ]);
    const fresh = await freshLogger();
    const listener = vi.fn();
    fresh.subscribe(listener);
    const before = fresh.getVersion();
    listener.mockClear();
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(fresh.getVersion()).toBeGreaterThan(before);
  });

  it("启动回读失败：本会话早期条目保留在缓冲，warn 追加在其后（不被清掉）", async () => {
    let rejectGet!: (err: Error) => void;
    fakeStore.get.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectGet = reject; }),
    );
    const fresh = await freshLogger();
    await vi.advanceTimersByTimeAsync(0);
    expect(typeof rejectGet).toBe("function");
    fresh.log.info("app", "早期条目");
    rejectGet(new Error("corrupted"));
    await vi.advanceTimersByTimeAsync(0);
    const entries = fresh.getEntries();
    expect(entries[0]!.message).toBe("早期条目");
    expect(entries.some((e) => e.level === "warn" && e.message.includes("读取失败"))).toBe(true);
  });

  it("启动回读与 clear() 竞态：清空之后不应被在途回读复活旧日志", async () => {
    let release!: (value: unknown) => void;
    fakeStore.get.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const fresh = await freshLogger();
    await vi.advanceTimersByTimeAsync(0);
    fresh.log.info("app", "本会话条目");
    await fresh.clear();
    expect(fresh.getEntries()).toHaveLength(0);
    expect(fakeStore.clear).toHaveBeenCalledTimes(1);
    release([
      { seq: 1, ts: "2026-10-01T00:00:00.000Z", level: "error", scope: "ui", message: "上次旧日志" },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    // clear 承诺「清空缓冲并清除落盘键」：在途回读落地不得把旧数据复活回内存
    expect(fresh.getEntries()).toHaveLength(0);
  });

  it("清空丢弃回读后，挂起的防抖 flush 只写清空后的缓冲（复活数据不回写落盘）", async () => {
    let release!: (value: unknown) => void;
    fakeStore.get.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const fresh = await freshLogger();
    await vi.advanceTimersByTimeAsync(0);
    fresh.log.info("app", "清空前条目");
    fakeStore.set.mockClear();
    await fresh.clear();
    release([
      { seq: 1, ts: "2026-10-01T00:00:00.000Z", level: "error", scope: "ui", message: "旧日志" },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fresh.getEntries()).toHaveLength(0);
    // 清空前调度的 3s 防抖 flush 到点：只允许写入当前（空）缓冲，不得回写旧日志
    await vi.advanceTimersByTimeAsync(3100);
    const calls = fakeStore.set.mock.calls as Array<[string, LogEntry[]]>;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("entries");
    expect(calls[0]![1]).toHaveLength(0);
  });

  it("清空后新写入 + 回读落地：新条目保留、旧数据丢弃（不复活也不误删）", async () => {
    let release!: (value: unknown) => void;
    fakeStore.get.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const fresh = await freshLogger();
    await vi.advanceTimersByTimeAsync(0);
    fresh.log.info("app", "清空前的条目");
    await fresh.clear();
    fresh.log.warn("store", "清空后的条目");
    release([
      { seq: 5, ts: "2026-10-01T00:00:00.000Z", level: "info", scope: "app", message: "旧日志甲" },
      { seq: 6, ts: "2026-10-01T00:00:01.000Z", level: "info", scope: "app", message: "旧日志乙" },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    const entries = fresh.getEntries();
    expect(entries.map((e) => e.message)).toEqual(["清空后的条目"]);
  });

  it("语义边界：清空后回读失败仍无条件降级（persistBroken 生效、warn 记入清空后的缓冲）", async () => {
    let rejectGet!: (err: Error) => void;
    fakeStore.get.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectGet = reject; }),
    );
    const fresh = await freshLogger();
    await vi.advanceTimersByTimeAsync(0);
    await fresh.clear();
    fakeStore.set.mockClear();
    fakeStore.save.mockClear();
    rejectGet(new Error("corrupted"));
    await vi.advanceTimersByTimeAsync(0);
    const entries = fresh.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("warn");
    expect(entries[0]!.message).toContain("读取失败");
    // 降级后继续写入：不再有任何落盘动作
    fresh.log.error("app", "降级后的错误");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fakeStore.set).not.toHaveBeenCalled();
    expect(fakeStore.save).not.toHaveBeenCalled();
  });

  it("落盘降级后 clear()：只清内存、不再触碰 store，且不抛出", async () => {
    fakeStore.set.mockRejectedValue(new Error("disk full"));
    const fresh = await freshLogger();
    fresh.log.info("app", "I1");
    await vi.advanceTimersByTimeAsync(3100);
    fakeStore.clear.mockClear();
    fakeStore.save.mockClear();
    await expect(fresh.clear()).resolves.toBeUndefined();
    expect(fresh.getEntries()).toHaveLength(0);
    expect(fakeStore.clear).not.toHaveBeenCalled();
  });
});

describe("检测 · 条目内容与缓冲", () => {
  let quiet: ReturnType<typeof quietConsole>;
  beforeEach(() => {
    quiet = quietConsole();
    vi.mocked(isTauri).mockReturnValue(false);
  });
  afterEach(() => {
    quiet.forEach((spy) => spy.mockRestore());
    vi.useRealTimers();
  });

  it("detail 序列化：Error 取 message、对象 String 化、未传时不产生字段；ts 可解析", async () => {
    const fresh = await freshLogger();
    fresh.log.error("llm", "调用失败", new Error("401 unauthorized"));
    fresh.log.info("store", "快照", { rows: 3 });
    fresh.log.info("app", "无 detail");
    const entries = fresh.getEntries();
    expect(entries[0]!.detail).toBe("401 unauthorized");
    expect(entries[1]!.detail).toBe(String({ rows: 3 }));
    expect(entries[2]).not.toHaveProperty("detail");
    expect(
      entries.every((e) => typeof e.seq === "number" && !Number.isNaN(Date.parse(e.ts))),
    ).toBe(true);
  });

  it("缓冲恒定上限：写入两倍上限后仍为 LIMIT 条，seq 全程单调递增", async () => {
    const fresh = await freshLogger();
    for (let i = 1; i <= LOG_BUFFER_LIMIT * 2; i += 1) fresh.log.debug("app", `D-${i}`);
    const entries = fresh.getEntries();
    expect(entries).toHaveLength(LOG_BUFFER_LIMIT);
    expect(entries[0]!.message).toBe(`D-${LOG_BUFFER_LIMIT + 1}`);
    const seqs = entries.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });
});
