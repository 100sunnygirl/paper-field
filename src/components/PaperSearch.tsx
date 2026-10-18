import { useEffect, useState } from "react";
import { repo } from "../lib/repo";
import { READING_STATUS_LABELS, type PaperListItem } from "../lib/types";
import { shortcut } from "../lib/util";
import { useField } from "../store";
import { Icon } from "./ui";

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
  const query = search.trim();

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
          placeholder="搜索标题、作者或 DOI"
          title="按标题、作者、标签或 DOI 搜索；下拉列出全部领域的匹配"
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
  );
}
