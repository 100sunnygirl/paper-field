import { describe, expect, it } from "vitest";
import { updaterPubkeyIsPlaceholder } from "./updater";

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
