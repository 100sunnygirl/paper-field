import { describe, expect, it } from "vitest";
import { keyPresence } from "./keyPresence";

describe("keyPresence", () => {
  it("reports each secret as a label and a state, and lets unreadable win", () => {
    const rows = keyPresence({
      hasKey: true,
      keyState: "unreadable",
      hasToken: true,
      hasOpenalexKey: false,
      hasS2Key: true,
    });
    expect(rows).toEqual([
      { label: "AI Key", state: "unreadable" },
      { label: "MinerU Token", state: "present" },
      { label: "OpenAlex Key", state: "absent" },
      { label: "Semantic Scholar Key", state: "present" },
    ]);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["label", "state"]);
  });

  it("uses hasKey when the key file can be read", () => {
    expect(
      keyPresence({ hasKey: true, keyState: "present", hasToken: false, hasOpenalexKey: false, hasS2Key: false })[0],
    ).toEqual({ label: "AI Key", state: "present" });
    expect(
      keyPresence({ hasKey: false, keyState: "absent", hasToken: false, hasOpenalexKey: true, hasS2Key: false })[0],
    ).toEqual({ label: "AI Key", state: "absent" });
  });
});
