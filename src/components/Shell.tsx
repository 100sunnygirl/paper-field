import { MODE_LABELS, type AppMode, type Domain } from "../lib/types";
import { shortcut } from "../lib/util";
import { useField } from "../store";
import { Button, Icon } from "./ui";

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
      <span className="ef-rail-sign" aria-hidden="true">
        PAPER FIELD
      </span>
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

export function Dock({
  search,
}: {
  domain: Domain | null;
  search: string;
}) {
  const setSearch = useField((s) => s.setSearch);
  const openDialog = useField((s) => s.openDialog);
  const mode = useField((s) => s.mode);

  return (
    <header className="ef-dock">
      <div className="ef-brand">
        <span className="ef-mark" aria-hidden="true" />
        <span>
          <strong>PAPER FIELD</strong>
          <small>论文现场 · 阅读工作台</small>
        </span>
      </div>
      {mode !== "system" ? (
        <label className="ef-search">
          <Icon name="search" />
          <input
            id="global-search"
            value={search}
            onChange={(e) => void setSearch(e.target.value)}
            placeholder="搜索标题、作者、标签或 DOI"
            aria-label="搜索论文"
          />
          <kbd>{shortcut("K")}</kbd>
        </label>
      ) : (
        <div className="ef-header-spacer" />
      )}
      <span className="ef-header-spacer" />
      {mode !== "system" ? (
        <Button type="button" className="new-paper" onClick={() => openDialog("paper")}>
          <Icon name="plus" />
          添加论文
        </Button>
      ) : null}
    </header>
  );
}

export function StatusStrip() {
  const stats = useField((s) => s.stats);
  const settings = useField((s) => s.settings);
  return (
    <footer className="ef-status">
      <span>
        已读 <b>{stats.read}</b> / {stats.total}
      </span>
      <span className="ok">
        开源 <b>{stats.openSource}</b>
      </span>
      <span className={stats.running || stats.queued ? "busy" : ""}>
        {stats.running ? <i className="ef-pulse" aria-hidden="true" /> : null}
        {stats.running
          ? `作业运行中 ${stats.running}`
          : stats.queued
            ? `作业等待 ${stats.queued}`
            : "队列空闲"}
      </span>
      <span>{settings.hasKey ? "AI 已配置" : "未配置 AI"}</span>
      <span className="right">
        快捷操作 <span className="mono">{shortcut("K")}</span> 搜索
      </span>
    </footer>
  );
}
