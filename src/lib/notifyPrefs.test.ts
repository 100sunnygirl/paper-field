import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_JOB_NOTIFY,
  loadJobNotifyPrefs,
  requestSystemNotifyPermission,
  resetJobNotifyPrefs,
  saveJobNotifyPrefs,
  systemNotify,
  systemNotifySupported,
} from "./notifyPrefs";

beforeEach(() => {
  resetJobNotifyPrefs();
});

afterEach(() => {
  resetJobNotifyPrefs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("偏好读写", () => {
  it("无记录时给默认值：开启提醒、批次汇总、不开系统通知", () => {
    expect(loadJobNotifyPrefs()).toEqual(DEFAULT_JOB_NOTIFY);
    expect(loadJobNotifyPrefs()).toEqual({ enabled: true, mode: "summary", system: false });
  });

  it("保存后可读回；仅失败 / 逐篇 / 系统通知都可切换", () => {
    saveJobNotifyPrefs({ enabled: true, mode: "failures", system: true });
    expect(loadJobNotifyPrefs()).toEqual({ enabled: true, mode: "failures", system: true });
    saveJobNotifyPrefs({ enabled: false, mode: "perItem", system: false });
    expect(loadJobNotifyPrefs()).toEqual({ enabled: false, mode: "perItem", system: false });
  });

  it("损坏的 JSON 或非法取值回默认（不抛错、不改行为）", () => {
    localStorage.setItem("paper-field.job-notify", "{not json");
    expect(loadJobNotifyPrefs()).toEqual(DEFAULT_JOB_NOTIFY);
    localStorage.setItem("paper-field.job-notify", JSON.stringify({ enabled: "yes", mode: "loud", system: 1 }));
    expect(loadJobNotifyPrefs()).toEqual({ enabled: true, mode: "summary", system: false });
  });
});

describe("系统通知", () => {
  it("环境无 Notification API 时：不支持、请求返回 unsupported、发送静默跳过", async () => {
    expect(systemNotifySupported()).toBe(false);
    expect(await requestSystemNotifyPermission()).toBe("unsupported");
    expect(() => systemNotify("标题", "内容")).not.toThrow();
  });

  it("权限已授予且窗口失焦时发送；聚焦时不打扰", () => {
    const created: Array<{ title: string; body: string }> = [];
    vi.stubGlobal("Notification", class {
      static permission = "granted";
      constructor(public title: string, public options?: { body?: string }) {
        created.push({ title, body: options?.body ?? "" });
      }
      onclick: (() => void) | null = null;
      close() {}
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    systemNotify("MinerU 解析批次结束", "成功 8 · 失败 2");
    expect(created).toEqual([{ title: "MinerU 解析批次结束", body: "成功 8 · 失败 2" }]);

    created.length = 0;
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    systemNotify("MinerU 解析批次结束", "成功 8 · 失败 2");
    expect(created).toEqual([]);
  });

  it("权限未授予（default）时不发送", () => {
    const created: unknown[] = [];
    vi.stubGlobal("Notification", class {
      static permission = "default";
      constructor() {
        created.push(1);
      }
      close() {}
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    expect(() => systemNotify("t", "b")).not.toThrow();
    expect(created).toEqual([]);
  });
});
