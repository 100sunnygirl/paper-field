import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MINERU,
  enabledSources,
  loadMineruSettings,
  mineruProbe,
  saveMineruSettings,
  testMineru,
  type MineruSaveInput,
} from "./mineru";

/**
 * mock invoke 路径：需要 isTauri() 为 true（window.__TAURI_INTERNALS__）。
 * 浏览器分支（localStorage）单独覆盖。
 */

function asTauri() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
}

function asBrowser() {
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
}

function baseInput(overrides: Partial<MineruSaveInput> = {}): MineruSaveInput {
  return {
    order: ["local", "ssh", "api"],
    local: { enabled: true, socketPath: "~/.mineru/doclib.sock" },
    ssh: {
      enabled: false,
      host: "imac",
      port: 22,
      user: "yang",
      identityFile: "",
      socketPath: "~/.mineru/doclib.sock",
      inboxDir: "~/.mineru/paper-field-inbox",
    },
    api: {
      token: null,
      modelVersion: "pipeline",
      language: "ch",
      enableFormula: true,
      enableTable: true,
    },
    tier: "standard",
    pageRange: "all",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  localStorage.clear();
});

afterEach(() => {
  asBrowser();
});

describe("loadMineruSettings（Tauri invoke 路径）", () => {
  beforeEach(() => asTauri());

  it("把后端 MineruPublic v2 JSON 规范化，并派生 configured", async () => {
    vi.mocked(invoke).mockResolvedValue({
      version: 2,
      order: ["ssh", "local", "api"],
      local: { enabled: false, socketPath: "~/.mineru/doclib.sock" },
      ssh: {
        enabled: true,
        host: "imac",
        port: 2222,
        user: "yang",
        identityFile: "~/.ssh/id_ed25519",
        socketPath: "/home/reader/.mineru/doclib.sock",
        inboxDir: "/home/reader/inbox",
      },
      api: { hasToken: false, modelVersion: "vlm", language: "en", enableFormula: false, enableTable: false },
      tier: "flash",
      pageRange: "1-5",
    });
    const settings = await loadMineruSettings();
    expect(invoke).toHaveBeenCalledWith("mineru_settings");
    expect(settings.version).toBe(2);
    expect(settings.order).toEqual(["ssh", "local", "api"]);
    expect(settings.ssh.enabled).toBe(true);
    expect(settings.ssh.port).toBe(2222);
    expect(settings.api.modelVersion).toBe("vlm");
    expect(settings.api.language).toBe("en");
    expect(settings.tier).toBe("flash");
    expect(settings.pageRange).toBe("1-5");
    // configured = order 中存在启用源（ssh.enabled → true）
    expect(settings.configured).toBe(true);
    expect(enabledSources(settings)).toEqual(["ssh"]);
  });

  it("三源全未启用时 configured=false（导入侧据此给出指引）", async () => {
    vi.mocked(invoke).mockResolvedValue({
      version: 2,
      order: ["local", "ssh", "api"],
      local: { enabled: false, socketPath: "" },
      ssh: { enabled: false, host: "", port: 22, user: "", identityFile: "", socketPath: "", inboxDir: "" },
      api: { hasToken: false, modelVersion: "pipeline", language: "ch", enableFormula: true, enableTable: true },
      tier: "standard",
      pageRange: "all",
    });
    const settings = await loadMineruSettings();
    expect(settings.configured).toBe(false);
    expect(enabledSources(settings)).toEqual([]);
  });

  it("api 的启用看 hasToken（api 块没有 enabled 字段）", async () => {
    vi.mocked(invoke).mockResolvedValue({
      version: 2,
      order: ["api"],
      local: { enabled: false, socketPath: "" },
      ssh: { enabled: false, host: "", port: 22, user: "", identityFile: "", socketPath: "", inboxDir: "" },
      api: { hasToken: true, modelVersion: "pipeline", language: "ch", enableFormula: true, enableTable: true },
      tier: "standard",
      pageRange: "all",
    });
    const settings = await loadMineruSettings();
    expect(enabledSources(settings)).toEqual(["api"]);
    expect(settings.configured).toBe(true);
    // order 缺失项按 local→ssh→api 补全
    expect(settings.order).toEqual(["api", "local", "ssh"]);
  });

  it("非法 order 项被过滤、重复被去重、缺失补全", async () => {
    vi.mocked(invoke).mockResolvedValue({
      version: 2,
      order: ["api", "bad-value", "api"],
      local: { enabled: false, socketPath: "" },
      ssh: { enabled: false, host: "", port: 22, user: "", identityFile: "", socketPath: "", inboxDir: "" },
      api: { hasToken: false, modelVersion: "pipeline", language: "ch", enableFormula: true, enableTable: true },
      tier: "standard",
      pageRange: "all",
    });
    const settings = await loadMineruSettings();
    expect(settings.order).toEqual(["api", "local", "ssh"]);
  });

  it("后端异常时向上抛出（init 侧 catch 回落默认值）", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("io"));
    await expect(loadMineruSettings()).rejects.toThrow("io");
  });
});

describe("v1 设置自动迁移（localStorage 旧值）", () => {
  beforeEach(() => asBrowser());

  it("mode=local：socket_path 双写 local+ssh，local 排在 order 首位", async () => {
    localStorage.setItem(
      "paper-field.mineru",
      JSON.stringify({
        mode: "local",
        socketPath: "/custom/doclib.sock",
        tier: "basic",
        pageRange: "2-9",
      }),
    );
    const settings = await loadMineruSettings();
    expect(settings.version).toBe(2);
    expect(settings.local.enabled).toBe(true);
    expect(settings.local.socketPath).toBe("/custom/doclib.sock");
    expect(settings.ssh.enabled).toBe(false);
    expect(settings.ssh.socketPath).toBe("/custom/doclib.sock");
    expect(settings.order).toEqual(["local", "ssh", "api"]);
    expect(settings.configured).toBe(true);
    expect(settings.tier).toBe("basic");
    expect(settings.pageRange).toBe("2-9");
  });

  it("mode=ssh：ssh_host/port/user/identity_file/remote_inbox 迁入 ssh 块", async () => {
    localStorage.setItem(
      "paper-field.mineru",
      JSON.stringify({
        mode: "ssh",
        socketPath: "/remote/doclib.sock",
        sshHost: "imac.local",
        sshPort: 2222,
        sshUser: "yang",
        identityFile: "~/.ssh/id_ed25519",
        remoteInbox: "/remote/inbox",
      }),
    );
    const settings = await loadMineruSettings();
    expect(settings.local.enabled).toBe(false);
    expect(settings.ssh.enabled).toBe(true);
    expect(settings.ssh.host).toBe("imac.local");
    expect(settings.ssh.port).toBe(2222);
    expect(settings.ssh.user).toBe("yang");
    expect(settings.ssh.identityFile).toBe("~/.ssh/id_ed25519");
    expect(settings.ssh.socketPath).toBe("/remote/doclib.sock");
    expect(settings.ssh.inboxDir).toBe("/remote/inbox");
    expect(settings.order).toEqual(["ssh", "local", "api"]);
  });

  it("mode=off：三源禁用，configured=false", async () => {
    localStorage.setItem("paper-field.mineru", JSON.stringify({ mode: "off" }));
    const settings = await loadMineruSettings();
    expect(settings.local.enabled).toBe(false);
    expect(settings.ssh.enabled).toBe(false);
    expect(settings.api.hasToken).toBe(false);
    expect(settings.configured).toBe(false);
  });

  it("无历史值时回落默认值", async () => {
    const settings = await loadMineruSettings();
    expect(settings).toEqual(DEFAULT_MINERU);
  });
});

describe("saveMineruSettings 浏览器分支 token 三态", () => {
  beforeEach(() => asBrowser());

  it("token=null 保留已存 token", async () => {
    localStorage.setItem("paper-field.mineru.token", "old-token");
    const saved = await saveMineruSettings(baseInput());
    expect(saved.api.hasToken).toBe(true);
    expect(localStorage.getItem("paper-field.mineru.token")).toBe("old-token");
  });

  it('token="" 清除已存 token', async () => {
    localStorage.setItem("paper-field.mineru.token", "old-token");
    const saved = await saveMineruSettings(
      baseInput({ api: { token: "", modelVersion: "pipeline", language: "ch", enableFormula: true, enableTable: true } }),
    );
    expect(saved.api.hasToken).toBe(false);
    expect(localStorage.getItem("paper-field.mineru.token")).toBeNull();
  });

  it("token=新值 写入并启用 api 源", async () => {
    const saved = await saveMineruSettings(
      baseInput({ api: { token: "new-token", modelVersion: "vlm", language: "en", enableFormula: true, enableTable: true } }),
    );
    expect(saved.api.hasToken).toBe(true);
    expect(saved.api.modelVersion).toBe("vlm");
    expect(localStorage.getItem("paper-field.mineru.token")).toBe("new-token");
  });
});

describe("其余命令封装", () => {
  beforeEach(() => asTauri());

  it("testMineru 透传 provider", async () => {
    vi.mocked(invoke).mockResolvedValue("连接正常");
    expect(await testMineru("ssh")).toBe("连接正常");
    expect(invoke).toHaveBeenCalledWith("mineru_test", { provider: "ssh" });
  });

  it("mineruProbe 把行规范化为 ProviderHealth", async () => {
    vi.mocked(invoke).mockResolvedValue([
      { provider: "local", ok: true, latencyMs: 8, message: "doclib 可达" },
      { provider: "api", ok: false, latencyMs: 0, message: "Token 无效" },
    ]);
    const healths = await mineruProbe();
    expect(healths).toEqual([
      { provider: "local", ok: true, latencyMs: 8, message: "doclib 可达" },
      { provider: "api", ok: false, latencyMs: 0, message: "Token 无效" },
    ]);
  });

  it("mineruProbe 失败时返回空数组而不是抛错（init 容错约定）", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("boom"));
    expect(await mineruProbe()).toEqual([]);
  });

  it("浏览器预览下 mineruProbe 直接返回空数组", async () => {
    asBrowser();
    expect(await mineruProbe()).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});
