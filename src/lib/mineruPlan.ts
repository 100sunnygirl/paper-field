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
