import { useMemo, useSyncExternalStore, type CSSProperties } from "react";
import { getActivity, subscribeActivity } from "../lib/activity";
import { deriveJobsView } from "../lib/jobsView";
import { hasUsableProvider } from "../lib/settings";
import {
  MINERU_PROVIDER_LABELS,
  MODE_LABELS,
  type AppMode,
} from "../lib/types";
import { shortcut } from "../lib/util";
import { useField } from "../store";
import { Icon } from "./ui";

const MODE_ICONS: Record<AppMode, "grid" | "archive" | "inbox" | "settings"> = {
  field: "grid",
  archive: "archive",
  intake: "inbox",
  system: "settings",
};

export function Rail({ mode }: { mode: AppMode }) {
  const setMode = useField((s) => s.setMode);
  const modes: AppMode[] = ["field", "archive", "intake"];

  return (
    <nav className="ef-rail" aria-label="主导航">
      {modes.map((id) => {
        const item = MODE_LABELS[id];
        return (
          <button
            key={id}
            type="button"
            className="ef-mode"
            data-mode={id}
            aria-current={mode === id ? "page" : undefined}
            onClick={() => void setMode(id)}
          >
            <Icon name={MODE_ICONS[id]} />
            <span>{item.zh}</span>
          </button>
        );
      })}
      <div className="ef-rail-fill" />
      <button
        type="button"
        className="ef-mode"
        data-mode="system"
        aria-current={mode === "system" ? "page" : undefined}
        onClick={() => void setMode("system")}
      >
        <Icon name="settings" />
        <span>{MODE_LABELS.system.zh}</span>
      </button>
    </nav>
  );
}

/**
 * 顶栏只放品牌。搜索与「添加论文」都作用于论文列表，放在列表栏里（PaperSearch /
 * PaperNav 底部），不在顶栏悬空。
 */
export function Dock() {
  return (
    <header className="ef-dock">
      <div className="ef-brand">
        <span className="ef-mark" aria-hidden="true" />
        <strong>PAPER FIELD</strong>
        <small>论文阅读工作台</small>
      </div>
    </header>
  );
}

/**
 * 状态条的作业入口：计数与作业面板同源（llm_jobs + 运行时实况），批次进行中时附一枚
 * 本批进度表；点击（或 ⌘J）展开作业面板，展开时入口亮起成「拉出的页签」。
 */
function JobsToggle() {
  const jobs = useField((s) => s.jobs);
  const jobsOpen = useField((s) => s.jobsOpen);
  const setJobsOpen = useField((s) => s.setJobsOpen);
  const activity = useSyncExternalStore(subscribeActivity, getActivity);
  // 状态条只用计数与批次进度，不需要走表（now 只影响用时类字段）。
  const view = useMemo(() => deriveJobsView({ jobs, activity, now: 0 }), [jobs, activity]);
  const { running, queued } = view.counts;
  const batch = view.batch?.state === "running" ? view.batch : null;
  const label = running ? `作业运行中 ${running}` : queued ? `作业等待 ${queued}` : "队列空闲";
  const className = ["ef-status-jobs", running || queued ? "busy" : "", jobsOpen ? "is-open" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={className}>
      <button
        id="jobs-toggle"
        type="button"
        aria-expanded={jobsOpen}
        aria-controls={jobsOpen ? "jobs-panel" : undefined}
        title={`作业面板（${shortcut("J")}）`}
        onClick={() => setJobsOpen(!jobsOpen)}
      >
        {running ? <i className="ef-pulse" aria-hidden="true" /> : null}
        <span>{label}</span>
        {batch ? (
          <>
            <span className="ef-status-sep" aria-hidden="true">·</span>
            <span>
              {batch.label} <b>{batch.processed}</b>/{batch.total}
            </span>
            <span
              className="ef-status-meter"
              aria-hidden="true"
              style={{ "--pf-meter": `${batch.percent}%` } as CSSProperties}
            />
          </>
        ) : null}
        <Icon name={jobsOpen ? "down" : "up"} />
      </button>
    </span>
  );
}

export function StatusStrip() {
  const stats = useField((s) => s.stats);
  const settings = useField((s) => s.settings);
  const mineru = useField((s) => s.mineru);
  const effectiveProvider = useField((s) => s.effectiveProvider);
  const mineruLabel = effectiveProvider
    ? `MinerU：${MINERU_PROVIDER_LABELS[effectiveProvider]}`
    : mineru.configured
      ? "MinerU 不可用，可到设置页查看原因"
      : "MinerU 未配置";
  return (
    <footer className="ef-status">
      <span>
        已读 <b>{stats.read}</b> / {stats.total}
      </span>
      <span className="ok">
        开源 <b>{stats.openSource}</b>
      </span>
      <JobsToggle />
      <span>{hasUsableProvider(settings) ? "AI 服务已配置" : "尚未配置 AI 服务"}</span>
      <span>{mineruLabel}</span>
      <span className="right">
        <span className="mono">{shortcut("K")}</span> 搜索
      </span>
    </footer>
  );
}
