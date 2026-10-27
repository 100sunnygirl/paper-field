import type { BiblioStatus } from "./biblio";
import type { LogEntry } from "./logger";
import type { MineruSettingsV2 } from "./mineru";
import type { LlmSettings } from "./types";
import { isTauri } from "./util";

/** 诊断包里最多带的日志条数（最新在前取尾）。 */
export const DIAGNOSTICS_LOG_LIMIT = 50;

export interface DiagnosticsInput {
  version: string | null;
  platform: string;
  /** 桌面版还是浏览器预览。 */
  runtime: string;
  llm: LlmSettings;
  mineru: MineruSettingsV2;
  biblio: BiblioStatus;
  logs: LogEntry[];
  /** 生成时间；缺省当前时间（测试可注入）。 */
  now?: Date;
}

/** 读取应用版本号；浏览器预览 / 读取失败返回 null。 */
export async function readAppVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return null;
  }
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 生成反馈问题用的诊断包（Markdown 文本，直接粘贴进 issue）：
 * 版本 / 平台 / 设置摘要（只含 hasKey 等状态，绝不包含任何密钥明文）/ 最近日志。
 * 日志条目在写入时已打码（sk- / Bearer 片段）。
 */
export function buildDiagnosticsReport(input: DiagnosticsInput): string {
  const now = input.now ?? new Date();
  const lines: string[] = [];
  lines.push("# Paper Field 诊断信息");
  lines.push("");
  lines.push("反馈问题时请把本文件全部内容粘贴到 issue 正文。");
  lines.push("");
  lines.push(`- 版本：${input.version ?? "未知"}`);
  lines.push(`- 平台：${input.platform}`);
  lines.push(`- 运行环境：${input.runtime}`);
  lines.push(`- 生成时间：${formatStamp(now.toISOString())}`);
  lines.push("");
  lines.push("## 设置摘要（不含任何密钥）");
  lines.push("");
  lines.push("### AI 服务");
  if (input.llm.providers.length) {
    for (const provider of input.llm.providers) {
      const key = provider.keyState === "unreadable" ? "Key 读取失败" : provider.hasKey ? "Key 已保存" : "未配置 Key";
      lines.push(
        `- ${provider.label}：${provider.enabled ? "已启用" : "已停用"}，${provider.baseUrl || "（未填地址）"}，模型 ${
          provider.model || "（未填）"
        }，${key}${provider.requiresKey ? "" : "（免 Key 服务）"}`,
      );
    }
  } else {
    lines.push("- 未配置任何提供商");
  }
  lines.push("");
  lines.push("### MinerU 解析源");
  lines.push(`- 回退顺序：${input.mineru.order.join(" → ")}`);
  lines.push(`- 本地 CLI：${input.mineru.local.enabled ? "启用" : "停用"}`);
  lines.push(`- SSH 远程：${input.mineru.ssh.enabled ? "启用" : "停用"}`);
  lines.push(
    `- 官方 API：${input.mineru.api.hasToken ? `Token 已保存（${input.mineru.api.modelVersion} / ${input.mineru.api.language}）` : "未配置 Token"}`,
  );
  lines.push("");
  lines.push("### 文献库");
  lines.push(`- 联系邮箱：${input.biblio.email.trim() ? "已配置" : "未配置"}`);
  lines.push(`- OpenAlex Key：${input.biblio.hasOpenalexKey ? "已保存" : "未配置"}`);
  lines.push(`- Semantic Scholar Key：${input.biblio.hasS2Key ? "已保存" : "未配置"}`);
  if (input.biblio.openalexRemainingUsd != null) {
    lines.push(`- OpenAlex 今日剩余：${input.biblio.openalexRemainingUsd.toFixed(3)} USD`);
  }
  lines.push("");
  lines.push(`## 最近日志（最新 ${Math.min(DIAGNOSTICS_LOG_LIMIT, input.logs.length)} 条，敏感片段已打码）`);
  lines.push("");
  lines.push("```");
  const recent = [...input.logs].slice(-DIAGNOSTICS_LOG_LIMIT).reverse();
  for (const entry of recent) {
    lines.push(
      `${formatStamp(entry.ts)} ${entry.level.toUpperCase()} ${entry.scope} ${entry.message}${entry.detail ? `：${entry.detail}` : ""}`,
    );
  }
  if (!recent.length) lines.push("（无日志）");
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}
