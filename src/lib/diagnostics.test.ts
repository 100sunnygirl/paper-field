import { describe, expect, it } from "vitest";
import { buildDiagnosticsReport, DIAGNOSTICS_LOG_LIMIT } from "./diagnostics";
import { DEFAULT_BIBLIO } from "./biblio";
import { DEFAULT_MINERU } from "./mineru";
import type { LogEntry } from "./logger";
import type { LlmSettings } from "./types";

function llm(): LlmSettings {
  return {
    version: 2,
    usage: {},
    providers: [
      {
        id: "p-1",
        presetId: "deepseek",
        label: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        enabled: true,
        hasKey: true,
        requiresKey: true,
      },
      {
        id: "p-2",
        presetId: null,
        label: "自定义服务",
        baseUrl: "",
        model: "",
        enabled: false,
        hasKey: false,
        requiresKey: true,
      },
    ],
  };
}

function entry(seq: number, message: string): LogEntry {
  return {
    seq,
    ts: new Date(Date.UTC(2026, 9, 27, 4, 5, 6)).toISOString(),
    level: "info",
    scope: "app",
    message,
  };
}

function report(overrides: Partial<Parameters<typeof buildDiagnosticsReport>[0]> = {}): string {
  return buildDiagnosticsReport({
    version: "0.2.17",
    platform: "MacIntel",
    runtime: "桌面版",
    llm: llm(),
    mineru: { ...DEFAULT_MINERU, api: { ...DEFAULT_MINERU.api, hasToken: true }, configured: true },
    biblio: { ...DEFAULT_BIBLIO, email: "a@b.c", hasOpenalexKey: true },
    logs: [entry(1, "第一条日志"), entry(2, "第二条日志")],
    now: new Date(2026, 9, 27, 8, 0, 0),
    ...overrides,
  });
}

describe("buildDiagnosticsReport", () => {
  it("包含版本、平台、运行环境与生成时间", () => {
    const text = report();
    expect(text).toContain("# Paper Field 诊断信息");
    expect(text).toContain("- 版本：0.2.17");
    expect(text).toContain("- 平台：MacIntel");
    expect(text).toContain("- 运行环境：桌面版");
    expect(text).toContain("- 生成时间：2026-10-27 08:00:00");
  });

  it("设置摘要只含状态不含密钥：提供商/解析源/文献库逐项列出", () => {
    const text = report();
    expect(text).toContain("- DeepSeek：已启用，https://api.deepseek.com/v1，模型 deepseek-chat，Key 已保存");
    expect(text).toContain("- 自定义服务：已停用，（未填地址），模型 （未填），未配置 Key");
    expect(text).toContain(`- 回退顺序：${DEFAULT_MINERU.order.join(" → ")}`);
    expect(text).toContain("- 官方 API：Token 已保存（");
    expect(text).toContain("- 联系邮箱：已配置");
    expect(text).toContain("- OpenAlex Key：已保存");
    expect(text).toContain("- Semantic Scholar Key：未配置");
    // 摘要永远不出现密钥字段
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(text).not.toMatch(/apiKey|Bearer /);
  });

  it("带最近日志（最新在上），空日志给占位", () => {
    const text = report();
    expect(text).toContain("## 最近日志（最新 2 条，敏感片段已打码）");
    const lines = text.split("\n");
    const second = lines.findIndex((line) => line.includes("第二条日志"));
    const first = lines.findIndex((line) => line.includes("第一条日志"));
    expect(second).toBeGreaterThan(-1);
    expect(second).toBeLessThan(first);
    expect(report({ logs: [] })).toContain("（无日志）");
  });

  it("日志超过上限只取最新一段", () => {
    const logs = Array.from({ length: DIAGNOSTICS_LOG_LIMIT + 30 }, (_, i) => entry(i + 1, `日志 ${i + 1}`));
    const text = report({ logs });
    expect(text).toContain(`最新 ${DIAGNOSTICS_LOG_LIMIT} 条`);
    expect(text).toContain(`日志 ${logs.length}`);
    expect(text).not.toContain("日志 1\n");
  });
});
