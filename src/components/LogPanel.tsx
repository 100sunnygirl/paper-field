import { useState, useSyncExternalStore, type CSSProperties } from "react";
import { exportStamp } from "../lib/export";
import { clear, getEntries, getVersion, subscribe, type LogEntry, type LogLevel, type LogScope } from "../lib/logger";
import { isTauri, pad2 } from "../lib/util";
import { useField } from "../store";
import { Button } from "./ui";

/** 级别过滤：错误 / 警告 / 信息 + 全部；关键词与模块筛选叠加。 */
type LogFilter = "all" | "error" | "warn" | "info";

const FILTERS: Array<{ key: LogFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "error", label: "错误" },
  { key: "warn", label: "警告" },
  { key: "info", label: "信息" },
];

const SCOPES: Array<{ key: LogScope | "all"; label: string }> = [
  { key: "all", label: "全部模块" },
  { key: "app", label: "app" },
  { key: "store", label: "store" },
  { key: "llm", label: "llm" },
  { key: "mineru", label: "mineru" },
  { key: "engine", label: "engine" },
  { key: "ui", label: "ui" },
];

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-- -- --:--:--";
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 导出为纯文本（复制 / 保存文件用）：最新在上，一行一条。 */
function asText(entries: LogEntry[]): string {
  return [...entries]
    .reverse()
    .map((e) => `${formatStamp(e.ts)} ${e.level.toUpperCase()} ${e.scope} ${e.message}${e.detail ? `：${e.detail}` : ""}`)
    .join("\n");
}

export function LogPanel({ focused = false }: { focused?: boolean }) {
  const setFlash = useField((s) => s.setFlash);
  const [filter, setFilter] = useState<LogFilter>("all");
  const [scope, setScope] = useState<LogScope | "all">("all");
  const [keyword, setKeyword] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  // 两段式订阅：getSnapshot 返回版本号原始值（返回新数组会无限重渲染），列表另行读取。
  // 订阅本身就是为了版本号变化时触发重渲染，返回值无需接收。
  useSyncExternalStore(subscribe, getVersion);
  const all = getEntries();
  const q = keyword.trim().toLowerCase();
  const entries = [...all]
    .reverse()
    .filter(
      (e) =>
        (filter === "all" || e.level === (filter as LogLevel)) &&
        (scope === "all" || e.scope === scope) &&
        (!q || `${e.scope} ${e.message}${e.detail ? `：${e.detail}` : ""}`.toLowerCase().includes(q)),
    );

  async function copyResults() {
    try {
      await navigator.clipboard.writeText(asText(entries));
      setFlash({ tone: "ok", text: `已复制当前筛选结果（${entries.length} 条）到剪贴板。` });
    } catch {
      // 非安全上下文 / 无剪贴板权限时 clipboard 可能不可用：降级为提示即可。
      setFlash({ tone: "warn", text: "复制运行日志失败：当前环境无法访问剪贴板。" });
    }
  }

  async function saveToFile() {
    const name = `paper-field-log-${exportStamp(new Date())}.txt`;
    const content = asText(entries);
    try {
      if (isTauri()) {
        const { invoke } = await import("@tauri-apps/api/core");
        // 保存目录由系统对话框弹出；取消返回 null。
        const dir = await invoke<string | null>("export_files", {
          files: [{ relativePath: name, content }],
        });
        if (!dir) return;
        setFlash({ tone: "ok", text: `日志已保存到 ${dir}` });
        return;
      }
      if (typeof URL.createObjectURL !== "function") {
        setFlash({ tone: "warn", text: "当前环境不支持下载文件，请改用「复制」。" });
        return;
      }
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      setFlash({ tone: "ok", text: `日志已下载为 ${name}` });
    } catch (err) {
      setFlash({ tone: "warn", text: `保存日志失败：${err instanceof Error ? err.message : String(err)}` });
    }
  }

  async function clearLogs() {
    setConfirmClear(false);
    await clear();
    setFlash({ tone: "ok", text: "运行日志已清空。" });
  }

  return (
    <article
      id="settings-logs"
      className={`page-block pf-stagger${focused ? " is-focused" : ""}`}
      style={{ "--pf-i": 2 } as CSSProperties}
    >
      <header className="ef-block-head">
        <h3>运行日志</h3>
        <p>最近 {all.length} 条本机运行记录（错误与警告通知自动入列）。日志只保存在本机，用于排查问题。</p>
      </header>
      <div className="ef-log-filters">
        <input
          type="search"
          value={keyword}
          placeholder="关键词筛选（消息 / 详情 / 模块）"
          aria-label="日志关键词筛选"
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setKeyword("");
          }}
        />
        <select aria-label="日志模块筛选" value={scope} onChange={(e) => setScope(e.target.value as LogScope | "all")}>
          {SCOPES.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
        <span className="ef-log-count">
          {entries.length}/{all.length} 条
        </span>
      </div>
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
          <Button type="button" size="sm" onClick={() => void copyResults()}>
            复制当前结果
          </Button>
          <Button type="button" size="sm" onClick={() => void saveToFile()}>
            保存为文件
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
          <p className="ef-log-empty">{q || scope !== "all" || filter !== "all" ? "没有符合筛选条件的日志。" : "暂无日志。"}</p>
        )}
      </div>
    </article>
  );
}
