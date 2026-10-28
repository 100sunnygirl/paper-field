import { useEffect, useState } from "react";
import { useSyncExternalStore } from "react";
import {
  JOB_STATUS_LABELS,
  JOB_TYPE_LABELS,
  type OpenSource,
  type PaperListItem,
} from "../lib/types";
import { getActivity, subscribeActivity } from "../lib/activity";
import { jobStageLine } from "../lib/jobsView";
import { repo } from "../lib/repo";
import { isArchiveStatsDismissed, readingStatsFrom, setArchiveStatsDismissed } from "../lib/readingStats";
import { pad2, shortcut } from "../lib/util";
import { useField, type ArchiveSort, type ArchiveView } from "../store";
import { useReadPulse } from "./useReadPulse";
import { CheckSquare, PaperMatrix, PaperRow } from "./PaperMatrix";
import { PaperSearch } from "./PaperSearch";
import { Button, Icon } from "./ui";

/** 搜索只改列表。进度和「本领域论文」沿用未过滤的领域论文，换领域后若搜索还在则补一次无搜索词的读取。 */
let domainCensus: { domainId: string; items: PaperListItem[] } | null = null;

const ARCHIVE_FILTERS: Array<{ value: OpenSource | "all"; label: string }> = [
  { value: "all", label: "全部" },
  { value: "open", label: "开源" },
  { value: "closed", label: "闭源" },
  { value: "request", label: "需申请" },
  { value: "unknown", label: "未知" },
];

const ARCHIVE_SORTS: Array<{ value: ArchiveSort; label: string }> = [
  { value: "recent-read", label: "最近已读" },
  { value: "oldest-read", label: "标记最久" },
  { value: "notes-recent", label: "最近改笔记" },
  { value: "year", label: "发表年份" },
  { value: "title", label: "标题" },
];

function timeOf(value: string | null | undefined): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** 归档的客户端筛选：开源状态与搜索词走 SQL，这里补领域 / 年份 / 笔记完整度组合。 */
export function filterArchiveItems(items: PaperListItem[], view: ArchiveView): PaperListItem[] {
  return items.filter(
    (paper) =>
      (!view.domainId || paper.domainId === view.domainId) &&
      (view.year == null || paper.year === view.year) &&
      (!view.notesIncomplete || (paper.notesFilled ?? 0) < 5),
  );
}

/** 归档的多维排序：返回新数组，不动 SQL 结果。 */
export function sortArchiveItems(items: PaperListItem[], sort: ArchiveSort): PaperListItem[] {
  const sorted = [...items];
  const titleOf = (paper: PaperListItem) => paper.titleZh || paper.title;
  sorted.sort((a, b) => {
    if (sort === "oldest-read") {
      // 没有已读时间戳的排最后（旧库兜底序里可能是 updated_at 起的作用）。
      const keyOf = (paper: PaperListItem) => {
        const t = timeOf(paper.readAt);
        return t === 0 ? Number.POSITIVE_INFINITY : t;
      };
      return keyOf(a) - keyOf(b);
    }
    if (sort === "notes-recent") return timeOf(b.notesRevisedAt) - timeOf(a.notesRevisedAt);
    if (sort === "year") return (b.year ?? 0) - (a.year ?? 0) || titleOf(a).localeCompare(titleOf(b), "zh");
    if (sort === "title") return titleOf(a).localeCompare(titleOf(b), "zh");
    return timeOf(b.readAt) - timeOf(a.readAt);
  });
  return sorted;
}

/** 归档空态：不止陈述事实，给出「怎么标已读」三步与两个下一步入口。 */
export function ArchiveEmptyGuide() {
  const intake = useField((s) => s.intake);
  const papers = useField((s) => s.papers);
  const selectDomain = useField((s) => s.selectDomain);
  const selectPaper = useField((s) => s.selectPaper);
  const setMode = useField((s) => s.setMode);
  // 第一篇未读优先从待处理里找（那是收新论文的地方），现场列表兜底。
  const first =
    intake.find((p) => p.readingStatus !== "read") ?? papers.find((p) => p.readingStatus !== "read") ?? null;
  return (
    <div className="ef-empty-guide">
      <p className="no-results">还没有手动标记已读的论文。</p>
      <ol className="ef-guide-steps">
        <li>在「现场」或「入库」打开一篇论文，点「打开 PDF」开始阅读。</li>
        <li>边读边写下五块现场笔记：总结 / 亮点 / 不足 / 启示 / 备注。</li>
        <li>
          读完按 <kbd>{shortcut("R")}</kbd> 或在资料栏把阅读状态改为「已读」，论文就会进入这里。
        </li>
      </ol>
      <div className="ef-guide-actions">
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={!first}
          title={first ? "打开第一篇未读论文" : "库里还没有论文，可先去入库导入"}
          onClick={() => {
            if (!first) return;
            void (async () => {
              await selectDomain(first.domainId);
              await selectPaper(first.id);
            })();
          }}
        >
          去读第一篇
        </Button>
        <Button type="button" size="sm" onClick={() => void setMode("intake")}>
          去入库看看
        </Button>
      </div>
    </div>
  );
}

/** 归档头部的阅读成果统计卡：本周/本月/连续阅读 + 今年已读与逐月分布（可安静关闭）。 */
export function ArchiveStatsCard({ items, onClose }: { items: PaperListItem[]; onClose: () => void }) {
  const stats = readingStatsFrom(items);
  const maxMonth = Math.max(1, ...stats.months);
  return (
    <div className="ef-archive-stats" aria-label="阅读成果回顾">
      <div className="ef-archive-stats-main">
        <span>
          本周已读 <b className="mono">{stats.week}</b>
        </span>
        <span>
          本月已读 <b className="mono">{stats.month}</b>
        </span>
        <span>
          连续阅读 <b className="mono">{stats.streak}</b> 天
        </span>
        <button
          type="button"
          className="ef-stats-close"
          aria-label="关闭阅读成果统计（不再显示）"
          title="关闭阅读成果统计（不再显示）"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="ef-archive-stats-year">
        <span>
          今年已读 <b className="mono">{stats.year}</b> 篇
          {stats.topDomain ? ` · 最常读 ${stats.topDomain}` : ""}
        </span>
        <span className="ef-stats-spark" aria-hidden="true">
          {stats.months.map((count, index) => (
            <i key={index} className={count ? "" : "is-zero"} style={{ height: `${Math.max(8, Math.round((count / maxMonth) * 100))}%` }} />
          ))}
        </span>
      </div>
    </div>
  );
}

export function PaperNav({ onPaperChosen }: { onPaperChosen?: () => void }) {
  const mode = useField((s) => s.mode);
  const domains = useField((s) => s.domains);
  const selectedDomainId = useField((s) => s.selectedDomainId);
  const papers = useField((s) => s.papers);
  const archive = useField((s) => s.archive);
  const intake = useField((s) => s.intake);
  const jobs = useField((s) => s.jobs);
  const selectedPaperId = useField((s) => s.selectedPaperId);
  const selectPaper = useField((s) => s.selectPaper);
  const openDialog = useField((s) => s.openDialog);
  const archiveFilter = useField((s) => s.archiveFilter);
  const setArchiveFilter = useField((s) => s.setArchiveFilter);
  const archiveView = useField((s) => s.archiveView);
  const setArchiveView = useField((s) => s.setArchiveView);
  const cancelJob = useField((s) => s.cancelJob);
  const retryFailedMineru = useField((s) => s.retryFailedMineru);
  const setJobsOpen = useField((s) => s.setJobsOpen);
  const highlightJob = useField((s) => s.highlightJob);
  // 阶段一句话与作业面板同一口径：入库页行内直接看到「已解析 n/N 页」等实况。
  const activity = useSyncExternalStore(subscribeActivity, getActivity);
  const search = useField((s) => s.search);
  const selectDomain = useField((s) => s.selectDomain);
  const setFlash = useField((s) => s.setFlash);
  const batchMode = useField((s) => s.batchMode);
  const checkedPaperIds = useField((s) => s.checkedPaperIds);
  const setBatchMode = useField((s) => s.setBatchMode);
  const toggleCheckedPaper = useField((s) => s.toggleCheckedPaper);
  const setCheckedPaperIds = useField((s) => s.setCheckedPaperIds);
  const [censusEpoch, setCensusEpoch] = useState(0);
  // 阅读成果统计卡：本机可安静关闭（关闭后不再出现）。
  const [statsDismissed, setStatsDismissed] = useState(() => isArchiveStatsDismissed());

  if (mode === "field" && selectedDomainId && !search.trim()) {
    domainCensus = { domainId: selectedDomainId, items: papers };
  }

  useEffect(() => {
    if (mode !== "field" || !selectedDomainId || !search.trim()) return;
    if (domainCensus?.domainId === selectedDomainId) return;
    let cancel = false;
    void repo
      .listPapers(selectedDomainId)
      .then((items) => {
        if (cancel) return;
        domainCensus = { domainId: selectedDomainId, items };
        setCensusEpoch((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [mode, selectedDomainId, search]);

  const domain = domains.find((d) => d.id === selectedDomainId) ?? null;
  const list = mode === "archive" ? archive : mode === "intake" ? intake : papers;
  // 归档客户端视图：领域 / 年份筛选 + 多维排序（开源状态与搜索仍由 SQL 完成）。
  const archiveItems =
    mode === "archive" ? sortArchiveItems(filterArchiveItems(archive, archiveView), archiveView.sort) : [];
  const visible = mode === "archive" ? archiveItems : list;
  // 按领域分组：只列归档里实际出现的领域（组头带已读数），行号在组间连续。
  const archiveDomains = domains.filter((d) => archive.some((p) => p.domainId === d.id));
  const archiveYears = [...new Set(archive.map((p) => p.year).filter((y): y is number => y != null))].sort(
    (a, b) => b - a,
  );
  let groupOffset = 0;
  const archiveGroups =
    mode === "archive" && archiveView.groupByDomain
      ? archiveDomains.map((domain) => {
          const papers = archiveItems.filter((p) => p.domainId === domain.id);
          const group = { domain, papers, offset: groupOffset };
          groupOffset += papers.length;
          return group;
        })
      : [];
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  function toggleArchiveGroup(domainId: string) {
    setCollapsedGroups((current) =>
      current.includes(domainId) ? current.filter((id) => id !== domainId) : [...current, domainId],
    );
  }
  /**
   * 归档行的次级操作区：领域短码徽标（点击筛选/再点取消该领域）与「在所属领域中打开」直达。
   * 直达后归档筛选保留在 store 里，切回归档即回到原筛选（列表滚动位置不保留）。
   */
  const archiveRowExtra = (paper: PaperListItem) => (
    <div className="ef-row-extra">
      <button
        type="button"
        className={`ef-row-domain-badge mono${archiveView.domainId === paper.domainId ? " is-active" : ""}`}
        title={`只看「${paper.domainName}」的已读论文（再点一次取消）`}
        aria-label={`只看领域 ${paper.domainName} 的已读论文`}
        aria-pressed={archiveView.domainId === paper.domainId}
        onClick={() =>
          setArchiveView({ domainId: archiveView.domainId === paper.domainId ? null : paper.domainId })
        }
      >
        {paper.domainCode || paper.domainName}
      </button>
      <button
        type="button"
        className="ef-row-domain-open"
        title={`进入「${paper.domainName}」现场阅读这篇论文`}
        onClick={() => {
          void (async () => {
            await selectDomain(paper.domainId);
            await selectPaper(paper.id);
            setFlash({ tone: "ok", text: "已在所属领域中打开；切回「归档」可回到原筛选列表。" });
          })();
        }}
      >
        在所属领域中打开
        <Icon name="right" />
      </button>
    </div>
  );
  const domainPapers =
    mode === "field" && domainCensus?.domainId === selectedDomainId ? domainCensus.items : papers;
  void censusEpoch;
  const failedParseCount = intake.filter((p) => p.mineruStatus === "error").length;
  const domainRead = domainPapers.filter((p) => p.readingStatus === "read").length;
  const fill = domainPapers.length ? domainRead / domainPapers.length : 0;
  // 全选以「可见列表」为准：客户端筛选（领域/年份）后勾选集里可能残留不可见项。
  const allChecked = visible.length > 0 && visible.every((p) => checkedPaperIds.includes(p.id));
  // 标已读（⌘R / 下拉）时：领域进度条 + 已读计数做一次 +1 微反馈。
  const readPulse = useReadPulse();

  // 批量模式下 Esc 退出。对话框打开时 Dialog 的捕获层会拦截 Esc，不会误退批量模式。
  useEffect(() => {
    if (!batchMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBatchMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [batchMode, setBatchMode]);

  return (
    <aside className="ef-nav" aria-label="领域与论文列表">
      {mode === "field" ? (
        <div className="ef-nav-head">
          <div className="ef-overline">
            <span>研究领域</span>
            {domain?.code ? <span className="ef-code">{domain.code}</span> : null}
          </div>
          <button
            type="button"
            className="ef-domain-picker"
            aria-label={domain?.name ? `切换研究领域：${domain.name}` : "切换研究领域"}
            onClick={() => openDialog("pick-domain")}
          >
            <h2>{domain?.name ?? "未选择领域"}</h2>
            <span className="ef-domain-select" aria-hidden="true">
              <Icon name="down" />
            </span>
          </button>
          <p className="ef-nav-sum">{domain?.summary ?? "选择或创建领域，开始组织论文。"}</p>
          <div className="ef-progress-label">
            <span>阅读进度</span>
            <span className="ef-progress-value">
              已读 <b className={`mono${readPulse ? " is-read-pulse" : ""}`}>{domainRead}</b>
              <span className="mono"> / {domainPapers.length}</span>
            </span>
          </div>
          <div className={`ef-progress${readPulse ? " is-read-pulse" : ""}`} aria-hidden="true">
            <i style={{ width: `${Math.round(fill * 100)}%` }} />
          </div>
        </div>
      ) : null}

      {mode === "archive" ? (
        <div className="ef-nav-head">
          <div className="ef-overline">
            <span>全部领域 · 已读</span>
          </div>
          <div className="ef-domain-picker">
            <h2>归档</h2>
          </div>
          <p className="ef-nav-sum">只有你手动标记已读的论文会出现在这里。AI 不会自动标记已读。</p>
          {!statsDismissed && archive.length ? (
            <ArchiveStatsCard
              items={archive}
              onClose={() => {
                setArchiveStatsDismissed();
                setStatsDismissed(true);
              }}
            />
          ) : null}
        </div>
      ) : null}

      {mode === "intake" ? (
        <div className="ef-nav-head">
          <div className="ef-overline">
            <span>全部领域 · 未手动标为已读</span>
          </div>
          <div className="ef-domain-picker">
            <h2>入库</h2>
          </div>
          <p className="ef-nav-sum">未手动标为已读的论文，以及 MinerU 解析和 AI 补全作业。</p>
          {failedParseCount ? (
            <div className="ef-job-row">
              <span className="status-error">解析失败 · {failedParseCount} 篇</span>
              <Button type="button" size="sm" onClick={() => void retryFailedMineru()}>
                全部重试
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {mode === "archive" ? (
        <div className="filter-row" role="group" aria-label="按开源状态筛选">
          {ARCHIVE_FILTERS.map((item) => (
            <Button
              key={item.value}
              type="button"
              size="sm"
              className={archiveFilter === item.value ? "is-active" : ""}
              aria-pressed={archiveFilter === item.value}
              onClick={() => void setArchiveFilter(item.value)}
            >
              {item.label}
            </Button>
          ))}
          {archive.length ? (
            <Button
              type="button"
              size="sm"
              className={archiveView.notesIncomplete ? "is-active" : ""}
              aria-pressed={archiveView.notesIncomplete}
              title="只看五块笔记还没写满的已读论文，方便回头补笔记"
              onClick={() => setArchiveView({ notesIncomplete: !archiveView.notesIncomplete })}
            >
              笔记未写满
            </Button>
          ) : null}
        </div>
      ) : null}

      {mode === "archive" && archive.length ? (
        <div className="ef-archive-tools" role="group" aria-label="归档筛选与排序">
          <label className="ef-tool-select">
            <span>领域</span>
            <select
              aria-label="按领域筛选归档"
              value={archiveView.domainId ?? ""}
              onChange={(e) => setArchiveView({ domainId: e.target.value || null })}
            >
              <option value="">全部领域</option>
              {archiveDomains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="ef-tool-select">
            <span>年份</span>
            <select
              aria-label="按发表年份筛选归档"
              value={archiveView.year ?? ""}
              onChange={(e) => setArchiveView({ year: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">全部年份</option>
              {archiveYears.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </label>
          <label className="ef-tool-select">
            <span>排序</span>
            <select
              aria-label="归档排序方式"
              value={archiveView.sort}
              onChange={(e) => setArchiveView({ sort: e.target.value as ArchiveSort })}
            >
              {ARCHIVE_SORTS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            size="sm"
            className={archiveView.groupByDomain ? "is-active" : ""}
            aria-pressed={archiveView.groupByDomain}
            onClick={() => setArchiveView({ groupByDomain: !archiveView.groupByDomain })}
          >
            按领域分组
          </Button>
        </div>
      ) : null}

      {mode === "intake" ? (
        <div className="ef-job-list">
          {/* 只显示进行中的作业：完成/失败的历史堆在这里会刷屏（曾经的「MinerU 解析 · 完成」墙），
              结果通知走右上角弹窗，失败可重试的入口在下方「解析失败 · N 篇」。
              行内文案与作业面板同一口径：标题 + 阶段一句话，点击在面板里高亮对应作业卡。 */}
          {jobs
            .filter((job) => job.status === "queued" || job.status === "running")
            .slice(0, 6)
            .map((job) => (
              <div key={job.id} className="ef-job-row">
                <button
                  type="button"
                  className="ef-job-row-main"
                  title="在作业面板查看这张作业卡"
                  onClick={() => highlightJob(job.id)}
                >
                  <span className={`status-${job.status}`}>
                    {job.status === "running" ? <i className="ef-pulse" aria-hidden="true" /> : null}
                    {JOB_TYPE_LABELS[job.type]} · {JOB_STATUS_LABELS[job.status]}
                  </span>
                  <b className="ef-job-row-title">{job.paperTitleZh || job.paperTitle || "标题待补全"}</b>
                  <span className="ef-job-row-stage">
                    {jobStageLine(job.type, job.status, activity.jobs[job.id])}
                  </span>
                </button>
                <Button type="button" size="sm" onClick={() => void cancelJob(job.id)}>
                  取消
                </Button>
              </div>
            ))}
          {jobs.filter((job) => job.status === "queued" || job.status === "running").length > 6 ? (
            <p className="ef-nav-sum">
              另有 {jobs.filter((job) => job.status === "queued" || job.status === "running").length - 6} 条进行中作业，
              可在作业面板查看全部。
            </p>
          ) : null}
          {jobs.filter((job) => job.status === "queued" || job.status === "running").length === 0 ? (
            <p className="ef-nav-sum">当前没有进行中的 AI 作业。</p>
          ) : null}
          <Button type="button" variant="link" className="ef-jobs-link" onClick={() => setJobsOpen(true)}>
            在作业面板查看阶段与进度
            <Icon name="right" />
          </Button>
        </div>
      ) : null}

      <div className="ef-nav-search">
        <PaperSearch />
      </div>

      <div className={`ef-list-head ${batchMode ? "is-batch" : ""}`.trim()}>
        {batchMode ? (
          <>
            <button
              type="button"
              className="ef-batch-all"
              role="checkbox"
              aria-checked={allChecked}
              onClick={() => setCheckedPaperIds(allChecked ? [] : visible.map((p) => p.id))}
            >
              <CheckSquare on={allChecked} />
              全选
            </button>
            <span className="ef-batch-count mono" aria-live="polite">
              已选 {checkedPaperIds.length} / {visible.length}
            </span>
            <span className="ef-batch-actions">
              {mode === "archive" ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={checkedPaperIds.length < 2}
                  title="勾选至少两篇已读论文后，生成五块笔记对照表"
                  onClick={() => openDialog("compare-notes")}
                >
                  对照表
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="danger"
                disabled={!checkedPaperIds.length}
                onClick={() => openDialog("delete-checked")}
              >
                <Icon name="trash" />
                删除
              </Button>
              <Button type="button" size="sm" variant="text" onClick={() => setBatchMode(false)}>
                退出
              </Button>
            </span>
          </>
        ) : (
          <>
            <span className="ef-list-title">
              {mode === "archive" ? "已读归档" : mode === "intake" ? "待处理论文" : "本领域论文"}
            </span>
            <span className="ef-list-head-right">
              <span className="ef-count mono">{pad2(mode === "field" ? domainPapers.length : visible.length)}</span>
              {visible.length ? (
                <Button
                  type="button"
                  size="sm"
                  variant="text"
                  className="ef-batch-toggle"
                  aria-label="批量选择论文"
                  title="批量选择论文"
                  onClick={() => setBatchMode(true)}
                >
                  <Icon name="batch" />
                  批量
                </Button>
              ) : null}
            </span>
          </>
        )}
      </div>

      {visible.length === 0 ? (
        mode === "archive" && !search.trim() && archive.length === 0 ? (
          <ArchiveEmptyGuide />
        ) : (
          <p className="no-results">
            {search.trim()
              ? "没有符合条件的论文。可以调整搜索词或切换领域。"
              : mode === "archive"
                ? archive.length
                  ? "没有符合条件的已读论文。可以调整上方的领域 / 年份筛选或开源状态。"
                  : "还没有手动标记已读的论文。"
                : mode === "intake"
                  ? "没有待处理论文。"
                  : "此领域还没有论文。"}
          </p>
        )
      ) : mode === "archive" && archiveView.groupByDomain ? (
        <div className="ef-paper-list" aria-label="已读归档（按领域分组）">
          {archiveGroups.map((group) => {
            const collapsed = collapsedGroups.includes(group.domain.id);
            return (
              <section key={group.domain.id} className="ef-row-group">
                <button
                  type="button"
                  className="ef-row-group-head"
                  aria-expanded={!collapsed}
                  aria-label={`${collapsed ? "展开" : "折叠"}领域分组：${group.domain.name}`}
                  onClick={() => toggleArchiveGroup(group.domain.id)}
                >
                  <span className={`ef-row-group-caret${collapsed ? " is-collapsed" : ""}`} aria-hidden="true">
                    <Icon name="down" />
                  </span>
                  <b>{group.domain.name}</b>
                  <span className="ef-row-group-code mono">{group.domain.code}</span>
                  <span className="ef-row-group-count">
                    已读 {group.papers.length} 篇
                  </span>
                </button>
                {collapsed
                  ? null
                  : group.papers.map((paper, index) => (
                      <PaperRow
                        key={paper.id}
                        paper={paper}
                        index={group.offset + index}
                        selected={paper.id === selectedPaperId}
                        onSelect={() => {
                          void selectPaper(paper.id);
                          onPaperChosen?.();
                        }}
                        batch={batchMode}
                        checked={checkedPaperIds.includes(paper.id)}
                        onToggleCheck={() => toggleCheckedPaper(paper.id)}
                        extra={archiveRowExtra(paper)}
                      />
                    ))}
              </section>
            );
          })}
        </div>
      ) : (
        <PaperMatrix
          papers={visible}
          selectedId={selectedPaperId}
          onSelect={(id) => {
            void selectPaper(id);
            onPaperChosen?.();
          }}
          batch={batchMode}
          checkedIds={checkedPaperIds}
          onToggleCheck={(id) => toggleCheckedPaper(id)}
          rowExtra={mode === "archive" ? archiveRowExtra : undefined}
        />
      )}

      {/* 添加论文落进当前领域：只在看得见目标领域的阅读页和收新论文的入库页提供；
          归档页只列已读论文，新论文不会出现在那里。领域切换走顶部领域名。 */}
      {mode === "field" || mode === "intake" ? (
        <div className="ef-nav-foot">
          <Button
            type="button"
            className="ef-add-paper"
            title={domain ? `导入 PDF 或手动录入，添加到「${domain.name}」` : "导入 PDF 或手动录入论文"}
            onClick={() => openDialog("paper")}
          >
            <Icon name="plus" />
            <span>添加论文</span>
            <kbd>{shortcut("N")}</kbd>
          </Button>
        </div>
      ) : null}
    </aside>
  );
}
