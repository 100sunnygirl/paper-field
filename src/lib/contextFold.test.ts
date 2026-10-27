import { beforeEach, describe, expect, it, vi } from "vitest";
import { getContextFold, setContextFolded, subscribeContextFold } from "./contextFold";

beforeEach(() => {
  localStorage.removeItem("paper-field.context-fold");
  // 恢复默认（全展开）：逐块写回 false。
  setContextFolded("links", false);
  setContextFolded("toc", false);
  setContextFolded("ai", false);
});

describe("contextFold · 资料栏折叠偏好", () => {
  it("setContextFolded 更新快照并写穿 localStorage", () => {
    setContextFolded("links", true);
    expect(getContextFold().folded.links).toBe(true);
    expect(JSON.parse(localStorage.getItem("paper-field.context-fold")!)).toEqual({
      links: true,
      toc: false,
      ai: false,
    });
  });

  it("订阅者在折叠变化时收到通知，取消订阅后不再收到", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeContextFold(listener);
    setContextFolded("toc", true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setContextFolded("toc", false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("重启（重新加载模块）后按 localStorage 恢复，坏字段被忽略", async () => {
    localStorage.setItem("paper-field.context-fold", JSON.stringify({ links: true, bad: "x", toc: 42 }));
    vi.resetModules();
    const fresh = await import("./contextFold");
    expect(fresh.getContextFold().folded.links).toBe(true);
    expect(fresh.getContextFold().folded.toc).toBeUndefined();
    expect(fresh.getContextFold().folded.ai).toBeUndefined();
  });

  it("localStorage 损坏时回落全展开，不抛错", async () => {
    localStorage.setItem("paper-field.context-fold", "{broken");
    vi.resetModules();
    const fresh = await import("./contextFold");
    expect(fresh.getContextFold().folded).toEqual({});
  });
});
