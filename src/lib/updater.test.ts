import { describe, expect, it } from "vitest";
import { checkAppUpdateInfo, installAppUpdate, updaterPubkeyIsPlaceholder } from "./updater";

describe("updaterPubkeyIsPlaceholder", () => {
  it("treats an empty key and the placeholder key as unset", () => {
    expect(updaterPubkeyIsPlaceholder("")).toBe(true);
    expect(updaterPubkeyIsPlaceholder(btoa("untrusted comment: minisign public key: PLACEHOLDER\nRWQexample\n"))).toBe(true);
  });

  it("ships a real release key, not the placeholder", () => {
    expect(updaterPubkeyIsPlaceholder(__PF_UPDATER_PUBKEY__)).toBe(false);
    expect(atob(__PF_UPDATER_PUBKEY__)).toContain("minisign public key: D7BE557F51D73642");
  });

  it("accepts a pubkey whose comment is not the placeholder", () => {
    const file = "untrusted comment: minisign public key: ABCDEF0123456789\nRWQexample\n";
    const pubkey = btoa(file);
    expect(updaterPubkeyIsPlaceholder(pubkey)).toBe(false);
  });
});

describe("checkAppUpdateInfo（检查与安装拆分）", () => {
  it("浏览器预览：unavailable，不触发下载", async () => {
    const info = await checkAppUpdateInfo();
    expect(info.status).toBe("unavailable");
    expect(info.message).toBe("检查更新只在桌面应用里可用。");
    expect(info.update).toBeUndefined();
  });

  it("没有检查到更新句柄时拒绝安装（先检查后安装）", async () => {
    await expect(installAppUpdate({ status: "available", message: "发现新版本。" })).rejects.toThrow(
      "尚未检查到可安装的更新",
    );
  });
});
