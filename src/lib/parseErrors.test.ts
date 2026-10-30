import { describe, expect, it } from "vitest";
import { classifyParseError, parseErrorSummary } from "./parseErrors";

describe("classifyParseError · 解析失败原因归类", () => {
  it("官方错误码与常见关键词映射为中文类别", () => {
    expect(classifyParseError("A0202: invalid token").key).toBe("token");
    expect(classifyParseError("Token 已过期，请重新获取").key).toBe("token");
    expect(classifyParseError("error -60018: daily page quota").key).toBe("quota");
    expect(classifyParseError("文件超过 200MB").key).toBe("oversize");
    expect(classifyParseError("-60006 文件超过 200 页").key).toBe("overpages");
    expect(classifyParseError("SSH connect timeout").key).toBe("network");
    expect(classifyParseError("No such file or directory").key).toBe("missing-file");
  });

  it("空与未知原因归「其他」，建议可读", () => {
    expect(classifyParseError(null).key).toBe("other");
    expect(classifyParseError("").key).toBe("other");
    expect(classifyParseError("某种全新的错误 XYZ").key).toBe("other");
    expect(classifyParseError(null).advice.length).toBeGreaterThan(0);
  });

  it("摘要折平空白并截断加省略号", () => {
    expect(parseErrorSummary("  多  行\n原因 ")).toBe("多 行 原因");
    const long = "长".repeat(50);
    const cut = parseErrorSummary(long);
    expect(cut.endsWith("…")).toBe(true);
    expect([...cut].length).toBe(40);
    expect(parseErrorSummary(null)).toBe("未记录原因");
  });
});
