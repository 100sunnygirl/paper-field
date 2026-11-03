import type { ProviderHealth } from "./mineru";
import type { MineruProviderKind } from "./types";
import { MINERU_PROVIDER_LABELS } from "./types";

/**
 * 与 Rust 侧 pick_provider 同义：按 order 取第一个 health.ok 的源。
 * healths 只包含启用源（后端 mineru_probe 仅探测启用源），无 ok 项即无可用源。
 */
export function pickProviderFromHealths(
  order: MineruProviderKind[],
  healths: ProviderHealth[],
): MineruProviderKind | null {
  for (const provider of order) {
    if (healths.some((item) => item.provider === provider && item.ok)) return provider;
  }
  return null;
}

/** 汇总各源失败原因（分号分隔）：「本地 CLI：原因；SSH 远程：原因」。ok 的源跳过。 */
export function summarizeHealths(
  order: MineruProviderKind[],
  healths: ProviderHealth[],
): string {
  const lines: string[] = [];
  for (const provider of order) {
    const item = healths.find((entry) => entry.provider === provider);
    if (item && !item.ok) {
      lines.push(`${MINERU_PROVIDER_LABELS[provider] ?? provider}：${item.message || "探测失败"}`);
    }
  }
  return lines.join("；");
}

export function providerLabel(provider: MineruProviderKind | string | null | undefined): string {
  if (!provider) return "—";
  return MINERU_PROVIDER_LABELS[provider] ?? provider;
}

/**
 * 测试连接失败时的修复建议：按失败文案关键词给一条可执行建议。
 * 认不出的失败不硬凑——返回 null，只显示原始原因。
 */
export function mineruFixHint(message: string): string | null {
  const text = message ?? "";
  if (/Token/i.test(text)) return "到 mineru.net 重新获取 Token 后填入（旧 Token 可能已过期）。";
  if (/私钥|identity/i.test(text)) return "检查私钥路径是否正确、文件权限是否仅本机可读（chmod 600）。";
  if (/socket|doclib/i.test(text)) return "确认 MinerU 文档库已启动、Socket 路径与部署一致。";
  if (/连接|超时|timeout|网络|unreachable|拒绝/i.test(text)) return "检查该源所在机器是否在线、地址与端口是否可达。";
  return null;
}
