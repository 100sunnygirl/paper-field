import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact";

describe("redactSecrets（SEC-015）", () => {
  it("保留原有 sk- 与 Bearer 规则", () => {
    expect(redactSecrets("failed sk-abcDEF1234 Bearer abc.def/token")).toBe("failed sk-… Bearer …");
  });

  it("JWT 形态的 token", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redactSecrets(`token=${jwt} rejected`)).toBe("token=eyJ… rejected");
    expect(redactSecrets(`auth ${jwt}`)).toBe("auth eyJ…");
  });

  it.each([
    ["x-api-key: abcdef1234567890", "x-api-key: …"],
    ['{"X-Api-Key":"abcdef1234567890"}', '{"X-Api-Key":"…"}'],
    ["x-goog-api-key=AIzaSyA-1234567890abc", "x-goog-api-key=…"],
  ])("头部 key：%s", (input, out) => {
    expect(redactSecrets(input)).toBe(out);
  });

  it.each([
    ["GET https://api.example.com/v1?api_key=abc123&page=2", "GET https://api.example.com/v1?api_key=…&page=2"],
    ["https://g.example/v1/models?key=AIzaSyXYZ", "https://g.example/v1/models?key=…"],
    ["https://x/y?a=1&token=t0k3n#frag", "https://x/y?a=1&token=…#frag"],
    ["https://x/y?access_token=abc&apikey=def", "https://x/y?access_token=…&apikey=…"],
    [
      "https://b.s3.amazonaws.com/a.pdf?X-Amz-Credential=AKIA%2F1&X-Amz-Signature=deadbeef",
      "https://b.s3.amazonaws.com/a.pdf?X-Amz-Credential=…&X-Amz-Signature=…",
    ],
    ["https://oss.example/a.pdf?Expires=1&Signature=abc%2Bdef", "https://oss.example/a.pdf?Expires=1&Signature=…"],
  ])("查询参数：%s", (input, out) => {
    expect(redactSecrets(input)).toBe(out);
  });

  it.each([
    ["https://user:hunter2@example.com/repo.git", "https://***@example.com/repo.git"],
    ["ssh://deploy@host:22/x", "ssh://***@host:22/x"],
    ["fetch failed: http://u:p@10.0.0.1:8080/a", "fetch failed: http://***@10.0.0.1:8080/a"],
  ])("URL userinfo：%s", (input, out) => {
    expect(redactSecrets(input)).toBe(out);
  });

  it("智谱 id.secret 形态的 key", () => {
    expect(redactSecrets("key 0123456789abcdef0123456789abcdef.AbCdEf1234567890 invalid")).toBe("key … invalid");
  });

  it.each([
    "HTTP 401: invalid api key, please check your settings",
    "请求 https://api.example.com/v1/chat?model=glm-4&page=2 超时",
    "monkey=1 turkey=2 keyboard",
    "邮件 someone@example.com 无法送达",
    "paper 10.1145/3292500.3330701 not found",
    "x-api-key: missing",
    "the token expired",
  ])("不误伤普通文本：%s", (text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it("对抗输入保持线性：长串 a.a.a 或 :// 不会卡住日志", () => {
    // 平方级回溯时 10 万次重复要十几秒以上；上限留足余量，只拦住退化，不因机器快慢抖动。
    for (const unit of ["a.", "://", "?key", "eyJ"]) {
      const started = Date.now();
      redactSecrets(unit.repeat(100_000));
      expect(Date.now() - started).toBeLessThan(3000);
    }
  });
});
