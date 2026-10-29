import { useState, useSyncExternalStore, type CSSProperties } from "react";
import { clear, getEntries, getVersion, subscribe, type LogEntry, type LogLevel } from "../lib/logger";
import { pad2 } from "../lib/util";
import { useField } from "../store";
import { Button } from "./ui";

/** 级别过滤：只读面板只留三档 + 全部（不做搜索 / 分页 / 导出）。 */
type LogFilter = "all" | "error" | "warn" | "info";

const FILTERS: Array<{ key: LogFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "error", label: "错误" },
  { key: "warn", label: "警告" },
  { key: "info", label: "信息" },
];

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-- -- --:--:--";
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 导出为纯文本（复制用）：最新在上，一行一条。 */
function asText(entries: LogEntry[]): string {
  return [...entries]
    .reverse()
    .map((e) => `${formatStamp(e.ts)} ${e.level.toUpperCase()} ${e.scope} ${e.message}${e.detail ? `：${e.detail}` : ""}`)
    .join("\n");
}

export function LogPanel({ id }: { id?: string }) {
  const setFlash = useField((s) => s.setFlash);
  const [filter, setFilter] = useState<LogFilter>("all");
  const [confirmClear, setConfirmClear] = useState(false);
  // 两段式订阅：getSnapshot 返回版本号原始值（返回新数组会无限重渲染），列表另行读取。
  // 订阅本身就是为了版本号变化时触发重渲染，返回值无需接收。
  useSyncExternalStore(subscribe, getVersion);
  const all = getEntries();
  const entries = [...all].reverse().filter((e) => filter === "all" || e.level === (filter as LogLevel));

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(asText(all));
      setFlash({ tone: "ok", text: "运行日志已复制到剪贴板。" });
    } catch {
      // 非安全上下文 / 无剪贴板权限时 clipboard 可能不可用：降级为提示即可。
      setFlash({ tone: "warn", text: "复制运行日志失败：当前环境无法访问剪贴板。" });
    }
  }

  async function clearLogs() {
    setConfirmClear(false);
    await clear();
    setFlash({ tone: "ok", text: "运行日志已清空。" });
  }

  return (
    <article id={id} className="page-block pf-stagger" style={{ "--pf-i": 2 } as CSSProperties}>
      <header className="ef-block-head">
        <h3>运行日志</h3>
        <p>最近 {all.length} 条本机运行记录（错误与警告通知自动入列）。日志只保存在本机，用于排查问题。</p>
      </header>
      <div className="ef-log-toolbar">
        <div className="ef-log-chips" role="group" aria-label="日志级别过滤">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={`ef-log-chip${filter === key ? " is-on" : ""}`}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="ef-log-actions">
          <Button type="button" size="sm" onClick={() => void copyAll()}>
            复制
          </Button>
          {confirmClear ? (
            <Button type="button" size="sm" className="ef-btn-danger-solid" onClick={() => void clearLogs()}>
              确认清空
            </Button>
          ) : (
            <Button type="button" size="sm" variant="danger" onClick={() => setConfirmClear(true)}>
              清空…
            </Button>
          )}
        </span>
      </div>
      <div className="ef-log-list" role="log" aria-label="运行日志">
        {entries.length ? (
          entries.map((entry) => (
            <div key={entry.seq} className={`ef-log-row is-${entry.level}`}>
              <span className="ef-log-stamp">{formatStamp(entry.ts)}</span>
              <span className="ef-log-level">{entry.level.toUpperCase()}</span>
              <span className="ef-log-scope">{entry.scope}</span>
              <span className="ef-log-msg">
                {entry.message}
                {entry.detail ? `：${entry.detail}` : ""}
              </span>
            </div>
          ))
        ) : (
          <p className="ef-log-empty">暂无日志。</p>
        )}
      </div>
    </article>
  );
}
