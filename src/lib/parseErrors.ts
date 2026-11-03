/**
 * MinerU 解析失败原因的归类与中文映射：官方错误码对照来自 README（A0202/A0211
 * Token、-60005 超大小、-60006 超页、-60018 当日额度），其余按关键词归类网络 /
 * 文件缺失，认不出的归「其他」。全部匹配在原始错误文本上做不区分大小写的包含匹配。
 */

export interface ParseErrorCategory {
  key: "token" | "quota" | "oversize" | "overpages" | "network" | "missing-file" | "other";
  /** 聚类标签（界面分组头）。 */
  label: string;
  /** 下一步建议（为何失败、该做什么）。 */
  advice: string;
  /** 对应设置卡锚点（openSystemCard 用）。 */
  anchor: string;
}

const CATEGORIES: Record<ParseErrorCategory["key"], ParseErrorCategory> = {
  token: {
    key: "token",
    label: "Token 问题",
    advice: "Token 无效或已过期，到设置页 MinerU 卡重新获取并保存 Token。",
    anchor: "mineru",
  },
  quota: {
    key: "quota",
    label: "额度用尽",
    advice: "当日 1000 页最高优先级额度已用尽，明天再试或改用本地 / SSH 解析源。",
    anchor: "mineru",
  },
  oversize: {
    key: "oversize",
    label: "文件超限",
    advice: "文件超过 200MB 上限，换压缩后的 PDF 或拆分后导入。",
    anchor: "mineru",
  },
  overpages: {
    key: "overpages",
    label: "页数超限",
    advice: "文件超过 200 页上限，用解析档位的页码范围分段提交。",
    anchor: "mineru",
  },
  network: {
    key: "network",
    label: "网络 / 连接",
    advice: "解析源连不上（网络、SSH 或本地 Socket）。到设置页「测试连接」排查。",
    anchor: "mineru",
  },
  "missing-file": {
    key: "missing-file",
    label: "文件缺失",
    advice: "PDF 文件不在预期位置（可能被移动或删除）。重新导入或到资料栏移除后重选 PDF。",
    anchor: "mineru",
  },
  other: {
    key: "other",
    label: "其他原因",
    advice: "原因未明。查看完整错误后重试；反复失败可换解析源。",
    anchor: "mineru",
  },
};

/** 按优先级匹配：具体错误码先于宽泛关键词；页数超限先于文件超限（「超过 200 页」含「超过 200」）。 */
const RULES: Array<{ key: ParseErrorCategory["key"]; patterns: string[] }> = [
  { key: "token", patterns: ["a0202", "a0211", "token", "unauthorized", "401", "鉴权", "过期"] },
  { key: "quota", patterns: ["-60018", "额度", "quota", "1000 页", "限流", "429"] },
  { key: "overpages", patterns: ["-60006", "超过 200 页", "页数", "too many pages"] },
  { key: "oversize", patterns: ["-60005", "200mb", "超过 200", "太大", "too large"] },
  { key: "missing-file", patterns: ["no such file", "找不到", "不存在", "enoent", "无法读取"] },
  { key: "network", patterns: ["网络", "超时", "timeout", "econnrefused", "socket", "ssh", "连接", "fetch failed", "502", "503", "504"] },
];

export function classifyParseError(raw: string | null | undefined): ParseErrorCategory {
  const text = (raw ?? "").toLowerCase();
  if (!text.trim()) return CATEGORIES.other;
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => text.includes(pattern))) return CATEGORIES[rule.key];
  }
  return CATEGORIES.other;
}

/** 行内原因摘要：折平空白、截断到 max 字（默认 40）加省略号。 */
export function parseErrorSummary(raw: string | null | undefined, max = 40): string {
  const flat = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "未记录原因";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
