/**
 * 论文搜索的结构化前缀语法：tag:/domain:/year:（可组合，其余文本仍走全文匹配）。
 * 例：tag:rlhf domain:指令对齐 year:2024 transformer
 * 解析永远成功：认不出的片段当普通文本，输入法半角全角冒号都支持。
 */

export interface ParsedSearchQuery {
  tags: string[];
  domains: string[];
  years: number[];
  text: string;
}

function splitPrefix(value: string, prefixes: string[]): Array<{ prefix: string; rest: string }> {
  const out: Array<{ prefix: string; rest: string }> = [];
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) out.push({ prefix, rest: value.slice(prefix.length) });
  }
  return out;
}

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const tags: string[] = [];
  const domains: string[] = [];
  const years: number[] = [];
  const textParts: string[] = [];
  // 中文全角冒号与半角冒号等价；token 之间按空白切。
  for (const token of raw.trim().split(/\s+/)) {
    if (!token) continue;
    const normalized = token.replace("：", ":");
    const prefixed = splitPrefix(normalized, ["tag:", "domain:", "year:", "d:"]);
    const hit = prefixed[0];
    const rest = hit?.rest ?? "";
    if (!hit || !rest) {
      textParts.push(token);
      continue;
    }
    if (hit.prefix === "tag:") tags.push(rest);
    else if (hit.prefix === "domain:" || hit.prefix === "d:") domains.push(rest);
    else {
      const year = Number.parseInt(rest, 10);
      if (Number.isFinite(year) && rest.match(/^\d{4}$/)) years.push(year);
      else textParts.push(token);
    }
  }
  return { tags, domains, years, text: textParts.join(" ") };
}

/** 查询是否携带结构化前缀（决定 UI 提示与后端走哪条查询）。 */
export function hasStructuredQuery(raw: string): boolean {
  const { tags, domains, years } = parseSearchQuery(raw);
  return tags.length > 0 || domains.length > 0 || years.length > 0;
}
