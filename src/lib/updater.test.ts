import { describe, expect, it } from "vitest";
import { updaterPubkeyIsPlaceholder } from "./updater";

describe("updaterPubkeyIsPlaceholder", () => {
  it("treats an empty key and the shipped placeholder as unset", () => {
    expect(updaterPubkeyIsPlaceholder("")).toBe(true);
    expect(updaterPubkeyIsPlaceholder(__PF_UPDATER_PUBKEY__)).toBe(true);
  });

  it("accepts a pubkey whose comment is not the placeholder", () => {
    const file = "untrusted comment: minisign public key: ABCDEF0123456789\nRWQexample\n";
    const pubkey = btoa(file);
    expect(updaterPubkeyIsPlaceholder(pubkey)).toBe(false);
  });
});
