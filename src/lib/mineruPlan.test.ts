import { describe, expect, it } from "vitest";
import type { ProviderHealth } from "./mineru";
import { pickProviderFromHealths, providerLabel, summarizeHealths } from "./mineruPlan";
import type { MineruProviderKind } from "./types";

function health(provider: MineruProviderKind, ok: boolean, message = ""): ProviderHealth {
  return { provider, ok, latencyMs: ok ? 12 : 0, message };
}

describe("pickProviderFromHealths（provider fallback）", () => {
  it("按 order 取第一个 ok 的源，跳过失败源", () => {
    const order: MineruProviderKind[] = ["local", "ssh", "api"];
    const healths = [
      health("local", false, "socket 不存在"),
      health("ssh", true, "SSH 可达"),
      health("api", true, "Token 有效"),
    ];
    expect(pickProviderFromHealths(order, healths)).toBe("ssh");
  });

  it("order 顺序优先于探测耗时：后启用源 ok 也不会抢先", () => {
    const order: MineruProviderKind[] = ["api", "local"];
    const healths = [health("local", true), health("api", true)];
    expect(pickProviderFromHealths(order, healths)).toBe("api");
  });

  it("全失败返回 null（导入侧据此给出指引）", () => {
    const order: MineruProviderKind[] = ["local", "ssh", "api"];
    const healths = [
      health("local", false, "a"),
      health("ssh", false, "b"),
      health("api", false, "c"),
    ];
    expect(pickProviderFromHealths(order, healths)).toBeNull();
  });

  it("仅启用源参与：order 里的未探测（未启用）源不会被选中", () => {
    // mineru_probe 只返回启用源：ssh 未启用时 healths 里没有它，
    // 即使 order 把 ssh 排在前面，也只能选到探测过的 local。
    const order: MineruProviderKind[] = ["ssh", "local"];
    const healths = [health("local", true)];
    expect(pickProviderFromHealths(order, healths)).toBe("local");
  });

  it("空探测列表返回 null（浏览器预览 / 尚未探测）", () => {
    expect(pickProviderFromHealths(["local", "ssh", "api"], [])).toBeNull();
  });

  it("空 order 返回 null", () => {
    expect(pickProviderFromHealths([], [health("local", true)])).toBeNull();
  });
});

describe("summarizeHealths（失败原因聚合）", () => {
  it("全失败时按 order 顺序聚合每源原因，分号分隔并带中文标签", () => {
    const order: MineruProviderKind[] = ["local", "ssh", "api"];
    const healths = [
      health("local", false, "socket 文件不存在"),
      health("ssh", false, "连接超时"),
      health("api", false, "Token 无效"),
    ];
    expect(summarizeHealths(order, healths)).toBe(
      "本地 CLI：socket 文件不存在；SSH 远程：连接超时；官方 API：Token 无效",
    );
  });

  it("ok 的源不出现在汇总里", () => {
    const order: MineruProviderKind[] = ["local", "ssh", "api"];
    const healths = [health("local", true, "ok"), health("ssh", false, "连接超时"), health("api", false, "x")];
    expect(summarizeHealths(order, healths)).not.toContain("本地 CLI");
    expect(summarizeHealths(order, healths)).toBe("SSH 远程：连接超时；官方 API：x");
  });

  it("失败但无 message 时显示「探测失败」", () => {
    expect(summarizeHealths(["local"], [health("local", false, "")])).toBe("本地 CLI：探测失败");
  });

  it("全部 ok 时返回空串", () => {
    const order: MineruProviderKind[] = ["local", "ssh"];
    expect(summarizeHealths(order, [health("local", true), health("ssh", true)])).toBe("");
  });
});

describe("providerLabel", () => {
  it("三源中文标签与 Rust provider_label 同值", () => {
    expect(providerLabel("local")).toBe("本地 CLI");
    expect(providerLabel("ssh")).toBe("SSH 远程");
    expect(providerLabel("api")).toBe("官方 API");
  });

  it("空值显示占位符", () => {
    expect(providerLabel(null)).toBe("—");
    expect(providerLabel(undefined)).toBe("—");
  });
});
