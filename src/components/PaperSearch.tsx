import { useEffect, useState } from "react";
import { repo } from "../lib/repo";
import { READING_STATUS_LABELS, type PaperListItem } from "../lib/types";
import { shortcut } from "../lib/util";
import { useField } from "../store";
import { Icon } from "./ui";

/** 搜索范围的本机偏好：domain = 只过滤当前领域列表；all = 额外跨领域检索（下拉）。 */
const SEARCH_SCOPE_KEY = "paper-field.search-scope";

function loadSearchScope(): "domain" | "all" {
  try {
    return localStorage.getItem(SEARCH_SCOPE_KEY) === "domain" ? "domain" : "all";
  } catch {
    return "all";
  }
}

function saveSearchScope(scope: "domain" | "all"): void {
  try {
    localStorage.setItem(SEARCH_SCOPE_KEY, scope);
  } catch {
    // 偏好存不进时按会话内选择走。
  }
}

/**
 * 论文列表顶部的搜索框：输入即过滤下方列表（store.setSearch），同时防抖跨领域检索
 * （repo.searchAll），以浮层列出全部领域的命中，点选即跳到对应领域与论文。
 * 放在它所过滤的列表上方，而不是顶栏：位置本身就说明了它搜的是论文。
 */
export function PaperSearch() {
  const search = useField((s) => s.search);
  const setSearch = useField((s) => s.setSearch);
  const selectDomain = useField((s) => s.selectDomain);
  const selectPaper = useField((s) => s.selectPaper);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeResults, setScopeResults] = useState<PaperListItem[] | null>(null);
  const [scopeSearching, setScopeSearching] = useState(false);
  // 范围显式化：默认「全部领域」（保持输入即出跨领域下拉的既有行为）。
  const [scope, setScope] = useState<"domain" | "all">(loadSearchScope);
  const query = search.trim();

  function chooseScope(next: "domain" | "all") {
    setScope(next);
    saveSearchScope(next);
    setScopeOpen(next === "all" && Boolean(query));
  }

  useEffect(() => {
    if (!query || scope !== "all") {
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
  }, [query, scope]);

  async function jumpToPaper(item: PaperListItem) {
    setScopeOpen(false);
    await selectDomain(item.domainId);
    await selectPaper(item.id);
  }

  return (
    <div className="ef-search-wrap">
      <label className="ef-search">
        <Icon name="search" />
        <input
          id="global-search"
          value={search}
          onChange={(e) => {
            if (scope === "all") setScopeOpen(true);
            void setSearch(e.target.value);
          }}
          onFocus={() => {
            if (query && scope === "all") setScopeOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && scopeOpen) {
              e.stopPropagation();
              setScopeOpen(false);
            }
          }}
          placeholder="搜索：标题、作者、DOI；支持 tag: domain: year:"
          title="按标题、作者、标签或 DOI 搜索；支持 tag:/domain:/year: 前缀（如 tag:rlhf year:2024）；范围可切换当前领域 / 全部领域"
          aria-label="搜索论文"
        />
        {search ? (
          <button
            type="button"
            className="ef-search-clear"
            aria-label="清空搜索"
            title="清空搜索"
            onClick={() => void setSearch("")}
          >
            <Icon name="close" />
          </button>
        ) : (
          <kbd>{shortcut("K")}</kbd>
        )}
      </label>
      {/* 范围显式化：当前领域只过滤下方列表；全部领域额外在下拉里跨领域检索。 */}
      {query ? (
        <div className="ef-search-scope-toggle" role="group" aria-label="搜索范围">
          <button
            type="button"
            aria-pressed={scope === "domain"}
            title="只过滤下方当前领域的论文列表"
            onClick={() => chooseScope("domain")}
          >
            当前领域
          </button>
          <button
            type="button"
            aria-pressed={scope === "all"}
            title="同时在全部领域检索，结果列在下拉里，点选跳转"
            onClick={() => chooseScope("all")}
          >
            全部领域
          </button>
        </div>
      ) : null}
      {scopeOpen && query ? (
        <div className="ef-search-scope" aria-label="跨领域搜索结果">
          <div className="ef-search-scope-head">
            <span>
              按「{query}」检索 · 全部领域共匹配 {scopeSearching ? "…" : (scopeResults?.length ?? 0)} 篇
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
  );
}
