import { describe, expect, it } from "vitest";
import { DOMAIN_ACCENTS, domainAccentVar, isDomainAccent } from "./domainExtras";

describe("domainExtras · 领域强调色板", () => {
  it("色板固定六枚，每枚都能映射到同名 CSS 变量", () => {
    expect(DOMAIN_ACCENTS).toHaveLength(6);
    for (const accent of DOMAIN_ACCENTS) {
      expect(domainAccentVar(accent.id)).toBe(`var(--pf-accent-${accent.id})`);
    }
  });

  it("未知或空值回落 null（用默认墨色）", () => {
    expect(domainAccentVar(null)).toBeNull();
    expect(domainAccentVar(undefined)).toBeNull();
    expect(domainAccentVar("hotpink")).toBeNull();
    expect(isDomainAccent("moss")).toBe(true);
    expect(isDomainAccent("signal")).toBe(false);
  });
});
