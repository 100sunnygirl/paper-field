import { describe, expect, it } from "vitest";
import { safeHttpUrl, withDefaultScheme } from "./urls";

describe("withDefaultScheme", () => {
  it.each([
    ["github.com/a/b", "https://github.com/a/b"],
    ["  www.example.org ", "https://www.example.org"],
    ["//cdn.example.org/x", "https://cdn.example.org/x"],
    ["example.org:8080/p", "https://example.org:8080/p"],
  ])("adds https to %s", (input, out) => {
    expect(withDefaultScheme(input)).toBe(out);
    expect(safeHttpUrl(withDefaultScheme(input))).not.toBeNull();
  });
  it.each(["https://a.org/x", "http://a.org", "javascript:alert(1)", "mailto:a@b.org", "not a url", "foo", "localhost:3000", ""])(
    "leaves %s alone",
    (input) => expect(withDefaultScheme(input)).toBe(input.trim()),
  );
  it("javascript: stays rejected", () => {
    expect(safeHttpUrl(withDefaultScheme("javascript:alert(1)"))).toBeNull();
  });
});
