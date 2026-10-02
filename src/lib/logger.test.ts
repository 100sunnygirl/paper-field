import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// plugin-store 统一替换为内存假 store：既隔离 IPC，也提供落盘行为断言。
const fakeStore = vi.hoisted(() => ({
  set: vi.fn(async (_key: string, _value: unknown) => undefined),
  get: vi.fn(async (_key?: string) => undefined as unknown),
  clear: vi.fn(async () => undefined),
  save: vi.fn(async () => undefined),
}));
const storeLoad = vi.hoisted(() =>
  vi.fn(async (_path: string, _options?: unknown) => fakeStore),
);
vi.mock("@tauri-apps/plugin-store", () => ({
  load: storeLoad,
}));

// isTauri 可按用例切换（默认 false = 浏览器 / jsdom 分支），其余 util 保持原实现。
vi.mock("./util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./util")>();
  return { ...actual, isTauri: vi.fn(() => false) };
});

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./util";
import { clear, getEntries, getVersion, log, subscribe, LOG_BUFFER_LIMIT } from "./logger";
import { bindToastLog, dismiss, getToasts, notify } from "../toasts";

/** 重置模块图后重新加载 logger：拿到全新的缓冲 / 序号 / 降级标记，用例间互不污染。 */
async function freshLogger() {
  vi.resetModules();
  return import("./logger");
}

/** 静音控制台镜像（环形淘汰等用例一次写数百条），并可在断言中读取调用记录。 */
function quietConsole() {
  const spies = (["debug", "log", "warn", "error"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  return spies;
}

describe("logger · 内存缓冲与订阅", () => {
  let quiet: ReturnType<typeof quietConsole>;
  beforeEach(async () => {
    quiet = quietConsole();
    vi.mocked(isTauri).mockReturnValue(false);
    await clear();
  });
  afterEach(() => {
    quiet.forEach((spy) => spy.mockRestore());
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("环形淘汰：超过 500 条时最旧的被移出，最新保留在尾", () => {
    for (let i = 1; i <= LOG_BUFFER_LIMIT + 2; i += 1) log.info("app", `条目 ${i}`);
    const entries = getEntries();
    expect(entries).toHaveLength(LOG_BUFFER_LIMIT);
    expect(entries[0]!.message).toBe("条目 3");
    expect(entries[entries.length - 1]!.message).toBe(`条目 ${LOG_BUFFER_LIMIT + 2}`);
  });

  it("订阅版本号随写入递增，退订后不再通知（getSnapshot 原始值语义）", () => {
    const before = getVersion();
    const listener = vi.fn();
    const off = subscribe(listener);
    log.info("app", "一");
    log.warn("store", "二");
    off();
    log.error("llm", "三");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getVersion()).toBe(before + 3);
  });

  it("控制台镜像按级别映射并带 [scope] 前缀；debug 仅 DEV 镜像", () => {
    const [debugSpy, logSpy, warnSpy, errorSpy] = quiet;
    log.info("mineru", "批次信息");
    expect(logSpy).toHaveBeenCalledWith("[mineru] 批次信息");
    log.error("ui", "出错了", new Error("boom"));
    expect(errorSpy).toHaveBeenCalledWith("[ui] 出错了：boom");
    log.warn("store", "小心");
    expect(warnSpy).toHaveBeenCalledWith("[store] 小心");
    vi.stubEnv("DEV", false);
    log.debug("app", "D-非开发");
    expect(debugSpy).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    log.debug("app", "D-开发");
    expect(debugSpy).toHaveBeenCalledWith("[app] D-开发");
  });

  it("非 Tauri：写入不触发任何 IPC、不动态加载 plugin-store", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockClear();
    vi.mocked(storeLoad).mockClear();
    log.error("app", "E1");
    log.warn("store", "W1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getEntries()).toHaveLength(2);
    expect(invoke).not.toHaveBeenCalled();
    expect(storeLoad).not.toHaveBeenCalled();
  });
});

describe("logger · Tauri 落盘", () => {
  let quiet: ReturnType<typeof quietConsole>;
  beforeEach(() => {
    quiet = quietConsole();
    vi.useFakeTimers();
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(storeLoad).mockClear();
    // mockReset 并恢复默认实现：上一用例注入的 mockRejectedValue 不得泄漏。
    fakeStore.set.mockReset();
    fakeStore.set.mockResolvedValue(undefined);
    fakeStore.save.mockReset();
    fakeStore.save.mockResolvedValue(undefined);
    fakeStore.clear.mockReset();
    fakeStore.clear.mockResolvedValue(undefined);
    fakeStore.get.mockReset();
    fakeStore.get.mockResolvedValue(undefined);
  });
  afterEach(() => {
    quiet.forEach((spy) => spy.mockRestore());
    vi.useRealTimers();
  });

  it("3s 尾沿防抖合并写入；落盘只含 ≥info 条目并显式 save", async () => {
    const fresh = await freshLogger();
    // bootstrap 在模块加载时即 load 一次（回读上次会话），此处只盯落盘副作用。
    storeLoad.mockClear();
    fakeStore.set.mockClear();
    fakeStore.save.mockClear();
    fresh.log.debug("app", "D-不落盘");
    fresh.log.info("app", "I1");
    fresh.log.error("ui", "E1");
    await vi.advanceTimersByTimeAsync(2999);
    expect(fakeStore.set).not.toHaveBeenCalled();
    expect(fakeStore.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(storeLoad).toHaveBeenCalledTimes(1);
    expect(fakeStore.set).toHaveBeenCalledTimes(1);
    const [key, value] = fakeStore.set.mock.calls[0]!;
    expect(key).toBe("entries");
    expect((value as Array<{ message: string }>).map((e) => e.message)).toEqual(["I1", "E1"]);
    expect(fakeStore.save).toHaveBeenCalledTimes(1);
  });

  it("落盘失败：静默降级为仅内存，只记一条 warn 且不再重试", async () => {
    fakeStore.set.mockRejectedValue(new Error("disk full"));
    const fresh = await freshLogger();
    fresh.log.info("app", "I1");
    await vi.advanceTimersByTimeAsync(3100);
    expect(
      fresh.getEntries().some((e) => e.level === "warn" && e.message.includes("落盘失败")),
    ).toBe(true);
    fakeStore.set.mockClear();
    fakeStore.save.mockClear();
    fresh.log.info("app", "I2");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fakeStore.set).not.toHaveBeenCalled();
    expect(fakeStore.save).not.toHaveBeenCalled();
  });

  it("clear 清空缓冲、清除落盘键并递增版本号", async () => {
    const fresh = await freshLogger();
    fresh.log.info("app", "I1");
    await vi.advanceTimersByTimeAsync(3100);
    expect(fakeStore.set).toHaveBeenCalledTimes(1);
    const before = fresh.getVersion();
    await fresh.clear();
    expect(fresh.getEntries()).toHaveLength(0);
    expect(fresh.getVersion()).toBeGreaterThan(before);
    expect(fakeStore.clear).toHaveBeenCalledTimes(1);
    expect(fakeStore.save).toHaveBeenCalledTimes(2);
  });

  it("启动回读：上次会话尾部进入本次缓冲头，序号接续（崩溃可回溯）", async () => {
    fakeStore.get.mockResolvedValue([
      { seq: 1, ts: "2026-10-01T00:00:00.000Z", level: "error", scope: "ui", message: "上次崩溃前的错误" },
      { seq: 2, ts: "2026-10-01T00:00:01.000Z", level: "info", scope: "mineru", message: "上次批次" },
    ] as unknown);
    const fresh = await freshLogger();
    await vi.advanceTimersByTimeAsync(0);
    expect(fresh.getEntries().map((e) => e.message)).toEqual(["上次崩溃前的错误", "上次批次"]);
    fresh.log.info("app", "新条目");
    const entries = fresh.getEntries();
    expect(entries[entries.length - 1]!.seq).toBe(3);
  });

  it("启动回读失败：按落盘故障降级（仅内存 + 一条 warn），不抛出", async () => {
    fakeStore.get.mockRejectedValue(new Error("corrupted"));
    const fresh = await freshLogger();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      fresh.getEntries().some((e) => e.level === "warn" && e.message.includes("读取失败")),
    ).toBe(true);
  });
});

describe("toasts · notify 日志收口与堆叠", () => {
  let quiet: ReturnType<typeof quietConsole>;
  beforeEach(async () => {
    quiet = quietConsole();
    vi.mocked(isTauri).mockReturnValue(false);
    await clear();
    // 产品侧 sink 由 main.tsx 注入（测试环境不经 main），此处接同规则映射：
    // emit 按 tone 映射级别（ok→info / warn→warn / error→error）。
    bindToastLog((event) => {
      if (event.action !== "emit") return;
      if (event.tone === "error") log.error("ui", event.text);
      else if (event.tone === "warn") log.warn("ui", event.text);
      else log.info("ui", event.text);
    });
  });
  afterEach(() => {
    bindToastLog(null);
    quiet.forEach((spy) => spy.mockRestore());
  });

  it("notify 是唯一收口：emit 事件按级别入日志（scope=ui，ok 记 info）", () => {
    notify("error", "NE");
    notify("warn", "NW");
    notify("ok", "NO");
    const entries = getEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ level: "error", scope: "ui", message: "NE" });
    expect(entries[1]).toMatchObject({ level: "warn", scope: "ui", message: "NW" });
    expect(entries[2]).toMatchObject({ level: "info", scope: "ui", message: "NO" });
  });

  it("同文案 refresh：堆叠不重复入列", () => {
    notify("ok", "DUP-TEXT");
    notify("ok", "DUP-TEXT");
    expect(getToasts().filter((t) => t.text === "DUP-TEXT")).toHaveLength(1);
  });

  it("堆叠上限 4 条：超出的最旧一条被逐出（evict）", () => {
    for (let i = 1; i <= 5; i += 1) notify("ok", `EVICT-${i}`);
    const texts = getToasts().map((t) => t.text);
    expect(texts).toHaveLength(4);
    expect(texts).not.toContain("EVICT-1");
    expect(texts).toContain("EVICT-5");
  });

  it("dismiss 手动关闭指定通知", () => {
    notify("ok", "DISMISS-ME");
    const item = getToasts().find((t) => t.text === "DISMISS-ME")!;
    dismiss(item.id);
    expect(getToasts().some((t) => t.id === item.id)).toBe(false);
  });
});
