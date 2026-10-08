import { useEffect, useState } from "react";
import { repo } from "../lib/repo";
import { hasUsableProvider } from "../lib/settings";
import {
  MINERU_PROVIDER_LABELS,
  MODE_LABELS,
  READING_STATUS_LABELS,
  type AppMode,
  type Domain,
  type PaperListItem,
} from "../lib/types";
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
  const selectDomain = useField((s) => s.selectDomain);
  const selectPaper = useField((s) => s.selectPaper);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeResults, setScopeResults] = useState<PaperListItem[] | null>(null);
  const [scopeSearching, setScopeSearching] = useState(false);
  const query = search.trim();

  // 跨领域检索（repo.searchAll）：与单领域列表过滤并行，作为搜索框的下拉结果。
  useEffect(() => {
    if (!query) {
      setScopeOpen(false);
      setScopeResults(null);
      setScopeSearching(false);
      return;
    }
    setScopeSearching(true);
    const timer = window.setTimeout(() => {
      repo
        .searchAll(query)
        .then((rows) => setScopeResults(rows))
        .catch(() => setScopeResults([]))
        .finally(() => setScopeSearching(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (mode === "system") setScopeOpen(false);
  }, [mode]);

  async function jumpToPaper(item: PaperListItem) {
    setScopeOpen(false);
    await selectDomain(item.domainId);
    await selectPaper(item.id);
  }

  return (
    <header className="ef-dock">
      <div className="ef-brand">
        <span className="ef-mark" aria-hidden="true" />
        <span>
          <strong>PAPER FIELD</strong>
          <small>论文阅读工作台</small>
        </span>
      </div>
      {mode !== "system" ? (
        <div className="ef-search-wrap">
          <label className="ef-search">
            <Icon name="search" />
            <input
              id="global-search"
              value={search}
              onChange={(e) => {
                setScopeOpen(true);
                void setSearch(e.target.value);
              }}
              onFocus={() => {
                if (query) setScopeOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape" && scopeOpen) {
                  e.stopPropagation();
                  setScopeOpen(false);
                }
              }}
              placeholder="搜索标题、作者、标签或 DOI"
              aria-label="搜索论文"
            />
            <kbd>{shortcut("K")}</kbd>
          </label>
          {scopeOpen && query ? (
            <div className="ef-search-scope" aria-label="跨领域搜索结果">
              <div className="ef-search-scope-head">
                <span>
                  全部领域共匹配 {scopeSearching ? "…" : (scopeResults?.length ?? 0)} 篇
                </span>
                <button type="button" onClick={() => setScopeOpen(false)}>
                  收起
                </button>
              </div>
              {scopeSearching ? (
                <p className="ef-search-scope-tip">
                  <i className="ef-pulse" aria-hidden="true" />
                  正在跨领域检索…
                </p>
              ) : scopeResults?.length ? (
                scopeResults.slice(0, 8).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="ef-search-scope-item"
                    onClick={() => void jumpToPaper(item)}
                  >
                    <span className="ef-search-scope-title">{item.titleZh || item.title}</span>
                    <span className="ef-search-scope-meta">
                      {item.domainName} · {item.firstAuthor ?? "作者待补充"} ·{" "}
                      {READING_STATUS_LABELS[item.readingStatus]}
                    </span>
                  </button>
                ))
              ) : (
                <p className="ef-search-scope-tip">没有匹配的论文。可以调整搜索词。</p>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="ef-header-spacer" />
      )}
      <span className="ef-header-spacer" />
      {mode !== "system" ? (
        <Button type="button" className="new-paper" onClick={() => openDialog("paper")}>
          <Icon name="plus" />
          导入 PDF
        </Button>
      ) : null}
    </header>
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
      <span className={stats.running || stats.queued ? "busy" : ""}>
        {stats.running ? <i className="ef-pulse" aria-hidden="true" /> : null}
        {stats.running
          ? `作业运行中 ${stats.running}`
          : stats.queued
            ? `作业等待 ${stats.queued}`
            : "队列空闲"}
      </span>
      <span>{hasUsableProvider(settings) ? "AI 服务已配置" : "尚未配置 AI 服务"}</span>
      <span>{mineruLabel}</span>
      <span className="right">
        <span className="mono">{shortcut("K")}</span> 搜索
      </span>
    </footer>
  );
}
