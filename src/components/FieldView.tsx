import { useEffect, useState } from "react";
import { useSyncExternalStore } from "react";
import {
  JOB_STATUS_LABELS,
  JOB_TYPE_LABELS,
  NOTE_LABELS,
  type LlmJob,
  type NoteKind,
  type OpenSource,
  type PaperListItem,
} from "../lib/types";
import { getActivity, subscribeActivity } from "../lib/activity";
import { jobStageLine } from "../lib/jobsView";
import { repo } from "../lib/repo";
import { isArchiveStatsDismissed, readingStatsFrom, setArchiveStatsDismissed } from "../lib/readingStats";
import { classifyParseError, parseErrorSummary } from "../lib/parseErrors";
import { deferredPaperIds, deferPaper, undeferPaper } from "../lib/deferredPapers";
import { readNextAdd, readNextList, readNextMove, readNextRemove } from "../lib/readNext";
import { pad2, shortcut } from "../lib/util";
import {
  DEFAULT_INTAKE_VIEW,
  useField,
  type ArchiveSort,
  type ArchiveView,
  type IntakeStage,
  type IntakeStageFilter,
  type IntakeView,
} from "../store";
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

const INTAKE_STAGES: Array<{ value: IntakeStageFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "error", label: "解析失败" },
  { value: "parsing", label: "解析中" },
  { value: "queued", label: "排队中" },
  { value: "pending", label: "待解析" },
  { value: "ready", label: "已解析待读" },
];

/** 论文在入库页的解析进度分组：失败 / 解析中（含已提交）/ 排队 / 待解析（含已取消）/ 已解析待读（含无 PDF 条目）。 */
export function intakeStageOf(paper: PaperListItem): IntakeStage {
  switch (paper.mineruStatus) {
    case "error":
      return "error";
    case "parsing":
    case "submitted":
      return "parsing";
    case "queued":
      return "queued";
    case "pending":
    case "cancelled":
      return "pending";
    default:
      return "ready";
  }
}

/** 入库列表排序：解析失败永远置顶（优先级最高的处理对象），其余保持库里的时间序。 */
export function sortIntakeByStage(items: PaperListItem[]): PaperListItem[] {
  const sorted = [...items];
  sorted.sort((a, b) => {
    const fa = a.mineruStatus === "error" ? 0 : 1;
    const fb = b.mineruStatus === "error" ? 0 : 1;
    return fa - fb;
  });
  return sorted;
}

/** 今日导入：createdAt 落在本地今天（自然日）的篇数。 */
export function countTodayImported(items: PaperListItem[], now: Date = new Date()): number {
  return items.filter((paper) => {
    const at = new Date(paper.createdAt);
    return (
      !Number.isNaN(at.getTime()) &&
      at.getFullYear() === now.getFullYear() &&
      at.getMonth() === now.getMonth() &&
      at.getDate() === now.getDate()
    );
  }).length;
}

const INTAKE_PERIODS: Array<{ value: IntakeView["period"]; label: string }> = [
  { value: "all", label: "全部时间" },
  { value: "today", label: "今天" },
  { value: "week", label: "本周" },
  { value: "month", label: "本月" },
];

const PROVIDER_LABELS: Record<string, string> = {
  local: "本地 CLI",
  ssh: "SSH 远程",
  api: "官方 API",
};

/** 入库的组合筛选：领域 + 入库日期（本地自然日口径）+ 解析源（__none__ = 未记录来源）。 */
export function filterIntakeItems(items: PaperListItem[], view: IntakeView, now: Date = new Date()): PaperListItem[] {
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = day(now);
  const weekStart = today - ((new Date(now).getDay() + 6) % 7) * 86_400_000;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return items.filter((paper) => {
    if (view.domainId && paper.domainId !== view.domainId) return false;
    if (view.provider === "__none__") {
      if (paper.mineruProvider) return false;
    } else if (view.provider && (paper.mineruProvider ?? "") !== view.provider) {
      return false;
    }
    if (view.period !== "all") {
      const at = new Date(paper.createdAt);
      if (Number.isNaN(at.getTime())) return false;
      const created = day(at);
      if (view.period === "today" && created !== today) return false;
      if (view.period === "week" && created < weekStart) return false;
      if (view.period === "month" && created < monthStart) return false;
    }
    return true;
  });
}

/**
 * 待处理行的组合状态标签：同时透出 MinerU 解析与著录补全两条流水线的进度
 * （如「解析完成 · 信息补全中」「解析失败 · 信息待补全」「无 PDF · 信息已补全」）。
 * 补全中的判定来自进行中的 prepareMeta 作业；已补全看 llmPreparedAt。
 */
export function intakeComboLabel(paper: PaperListItem, jobs: LlmJob[]): string {
  const parsePart = !paper.pdfPath
    ? "无 PDF"
    : paper.mineruStatus === "done"
      ? "解析完成"
      : paper.mineruStatus === "error"
        ? "解析失败"
        : paper.mineruStatus === "parsing" || paper.mineruStatus === "submitted"
          ? "解析中"
          : paper.mineruStatus === "queued"
            ? "排队中"
            : paper.mineruStatus === "pending"
              ? "待解析"
              : paper.mineruStatus === "cancelled"
                ? "已取消解析"
                : "未解析";
  const metaBusy = jobs.some(
    (job) => job.paperId === paper.id && job.type === "prepareMeta" && (job.status === "queued" || job.status === "running"),
  );
  const metaPart = metaBusy ? "信息补全中" : paper.llmPreparedAt ? "信息已补全" : "信息待补全";
  return `${parsePart} · ${metaPart}`;
}

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

/** 入库队列清空的完结时刻：一句祝贺 + 「去看已读归档」出口。 */
export function IntakeClearedGuide() {
  const setMode = useField((s) => s.setMode);
  return (
    <div className="ef-empty-guide ef-intake-cleared">
      <p className="no-results" role="status">
        队列已清空——没有待处理的论文，也没有进行中的作业。处理完的论文在归档里。
      </p>
      <div className="ef-guide-actions">
        <Button type="button" size="sm" variant="primary" onClick={() => void setMode("archive")}>
          去看已读归档
        </Button>
      </div>
    </div>
  );
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
  const openPaperFulltext = useField((s) => s.openPaperFulltext);
  const archiveFilter = useField((s) => s.archiveFilter);
  const setArchiveFilter = useField((s) => s.setArchiveFilter);
  const archiveView = useField((s) => s.archiveView);
  const setArchiveView = useField((s) => s.setArchiveView);
  const intakeStage = useField((s) => s.intakeStage);
  const setIntakeStage = useField((s) => s.setIntakeStage);
  const intakeView = useField((s) => s.intakeView);
  const setIntakeView = useField((s) => s.setIntakeView);
  const cancelJob = useField((s) => s.cancelJob);
  const retryMineruPapers = useField((s) => s.retryMineruPapers);
  const retryMineru = useField((s) => s.retryMineru);
  const openSystemCard = useField((s) => s.openSystemCard);
  const setJobsOpen = useField((s) => s.setJobsOpen);
  const highlightJob = useField((s) => s.highlightJob);
  // 阶段一句话与作业面板同一口径：入库页行内直接看到「已解析 n/N 页」等实况。
  const activity = useSyncExternalStore(subscribeActivity, getActivity);
  const search = useField((s) => s.search);
  const selectDomain = useField((s) => s.selectDomain);
  const setFlash = useField((s) => s.setFlash);
  const setReadingStatus = useField((s) => s.setReadingStatus);
  const batchMode = useField((s) => s.batchMode);
  const checkedPaperIds = useField((s) => s.checkedPaperIds);
  const setBatchMode = useField((s) => s.setBatchMode);
  const toggleCheckedPaper = useField((s) => s.toggleCheckedPaper);
  const setCheckedPaperIds = useField((s) => s.setCheckedPaperIds);
  const [censusEpoch, setCensusEpoch] = useState(0);
  // 阅读成果统计卡：本机可安静关闭（关闭后不再出现）。
  const [statsDismissed, setStatsDismissed] = useState(() => isArchiveStatsDismissed());
  // 失败原因聚类展开（入库页）：默认收起，展开后按根因分组显示。
  const [failuresOpen, setFailuresOpen] = useState(false);
  // 首次导入引导卡：导入过一次且未收起时出现（收起后不再显示）。
  const [intakeGuideDismissed, setIntakeGuideDismissed] = useState(
    () => localStorage.getItem("paper-field.intake-guide-dismissed") === "1",
  );
  // 入库作业行就地展开：超过 6 条先截断，展开后全部就地显示。
  const [jobsExpanded, setJobsExpanded] = useState(false);
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");
  // 「接下来读」个人短队列（本机记录；version 触发重读 localStorage）。
  const [readNextVersion, setReadNextVersion] = useState(0);
  void readNextVersion;
  const readNextIds = mode === "intake" ? readNextList() : [];
  const bumpReadNext = () => setReadNextVersion((v) => v + 1);
  // 「暂缓处理」的失败论文（本机记录；折叠到次要区）。
  const [deferredVersion, setDeferredVersion] = useState(0);
  void deferredVersion;
  const deferredIds = mode === "intake" ? deferredPaperIds() : [];
  const deferredById = new Map(intake.filter((p) => deferredIds.includes(p.id)).map((p) => [p.id, p]));
  // 下一篇建议：已解析完成里最早导入的一篇（先导入先读）；已在队列里的不再重复推荐。
  const readNextSuggestion =
    [...intake]
      .filter((p) => p.mineruStatus === "done" && !readNextIds.includes(p.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
  const readNextById = new Map(intake.map((p) => [p.id, p]));

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
  // 入库按解析进度筛选 + 失败置顶（chips 见列表上方的分组行）。
  const intakeStageCounts = new Map<IntakeStage, number>();
  if (mode === "intake") {
    for (const paper of intake) intakeStageCounts.set(intakeStageOf(paper), (intakeStageCounts.get(intakeStageOf(paper)) ?? 0) + 1);
  }
  const intakeItems =
    mode === "intake"
      ? sortIntakeByStage(
          filterIntakeItems(
            intake.filter(
              (p) => !deferredIds.includes(p.id) && (intakeStage === "all" || intakeStageOf(p) === intakeStage),
            ),
            intakeView,
          ),
        )
      : [];
  const todayImportedCount = mode === "intake" ? countTodayImported(intake) : 0;
  const visible = mode === "archive" ? archiveItems : mode === "intake" ? intakeItems : list;
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
  // 搜索范围扩展（含笔记 / 含全文）时的行内命中片段：按论文 id 记一块笔记命中 + 一条全文命中。
  const [hitLines, setHitLines] = useState<
    Record<string, { notes?: { kind: NoteKind; snippet: string }; fulltext?: string }>
  >({});
  const hitScopeKey = `${archiveView.searchNotes ? "n" : ""}${archiveView.searchFulltext ? "f" : ""}`;
  const hitIdsKey = archiveItems.map((p) => p.id).join(",");
  useEffect(() => {
    if (mode !== "archive" || !search.trim() || (!archiveView.searchNotes && !archiveView.searchFulltext)) {
      setHitLines({});
      return;
    }
    let cancelled = false;
    const ids = hitIdsKey ? hitIdsKey.split(",") : [];
    void Promise.all([
      archiveView.searchNotes ? repo.noteHitExcerpts(search.trim(), ids) : Promise.resolve([]),
      archiveView.searchFulltext ? repo.fulltextHitExcerpts(search.trim(), ids) : Promise.resolve([]),
    ])
      .then(([notes, fulltext]) => {
        if (cancelled) return;
        const map: Record<string, { notes?: { kind: NoteKind; snippet: string }; fulltext?: string }> = {};
        for (const hit of notes) {
          map[hit.paperId] = { ...map[hit.paperId], notes: { kind: hit.kind, snippet: hit.snippet } };
        }
        for (const hit of fulltext) map[hit.paperId] = { ...map[hit.paperId], fulltext: hit.snippet };
        setHitLines(map);
      })
      .catch(() => {
        // 片段只是辅助展示：读不到就安静略过（列表本身仍来自 SQL 结果）。
        if (!cancelled) setHitLines({});
      });
    return () => {
      cancelled = true;
    };
    // hitIdsKey/hitScopeKey 已把易变引用压平成字符串，避免每渲染都重查。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, search, hitScopeKey, hitIdsKey]);
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
      {hitLines[paper.id]?.notes ? (
        <p className="ef-row-hit">
          笔记命中 · {NOTE_LABELS[hitLines[paper.id]!.notes!.kind].zh}：{hitLines[paper.id]!.notes!.snippet}
        </p>
      ) : null}
      {hitLines[paper.id]?.fulltext ? (
        <p className="ef-row-hit">全文命中：{hitLines[paper.id]!.fulltext}</p>
      ) : null}
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
      {/* 重新在读：归档整理时不必打开资料栏 select 往返；首次已读时间戳由 repo 保护不重算。 */}
      <button
        type="button"
        className="ef-row-domain-open"
        title="把这篇论文改回「在读」（首次标记已读的时间保留不变）"
        onClick={() => void setReadingStatus("reading", paper.id)}
      >
        重新在读
      </button>
    </div>
  );
  /** 入库行的组合状态标签：解析 + 补全两条流水线一眼可见。 */
  const intakeRowExtra = (paper: PaperListItem) => (
    <div className="ef-row-extra">
      <span className="ef-row-combo">{intakeComboLabel(paper, jobs)}</span>
      {paper.mineruStatus === "error" ? (
        <>
          <span className="ef-row-reason" title={paper.mineruError ?? undefined}>
            原因 · {classifyParseError(paper.mineruError).label}：{parseErrorSummary(paper.mineruError)}
          </span>
          <button
            type="button"
            className="ef-row-domain-open"
            title="重新提交这篇论文给 MinerU 解析"
            onClick={() => void retryMineru(paper.id)}
          >
            重试
          </button>
          <button
            type="button"
            className="ef-row-domain-open"
            title="先放一放：折叠到「暂缓处理」区，不占主视野"
            onClick={() => {
              deferPaper(paper.id);
              setDeferredVersion((v) => v + 1);
            }}
          >
            暂缓处理
          </button>
          <button
            type="button"
            className="ef-row-domain-open"
            title={classifyParseError(paper.mineruError).advice}
            onClick={() => openSystemCard(classifyParseError(paper.mineruError).anchor)}
          >
            查看解决办法
          </button>
        </>
      ) : null}
      {paper.mineruStatus === "done" ? (
        readNextIds.includes(paper.id) ? (
          <span className="ef-row-inqueue">已在接下来读</span>
        ) : (
          <button
            type="button"
            className="ef-row-domain-open"
            title="加入「接下来读」个人短队列"
            onClick={() => {
              readNextAdd(paper.id);
              bumpReadNext();
            }}
          >
            + 接下来读
          </button>
        )
      ) : null}
    </div>
  );
  /** 失败原因按根因聚类（展开面板用）。 */
  const failureClusters = Object.entries(
    intake
      .filter((p) => p.mineruStatus === "error")
      .reduce<Record<string, PaperListItem[]>>((acc, paper) => {
        const key = classifyParseError(paper.mineruError).key;
        acc[key] = [...(acc[key] ?? []), paper];
        return acc;
      }, {}),
  );
  const domainPapers =
    mode === "field" && domainCensus?.domainId === selectedDomainId ? domainCensus.items : papers;
  void censusEpoch;
  const failedParseCount = intake.filter((p) => p.mineruStatus === "error").length;
  const domainRead = domainPapers.filter((p) => p.readingStatus === "read").length;
  const fill = domainPapers.length ? domainRead / domainPapers.length : 0;
  // 全选以「可见列表」为准：客户端筛选（领域/年份）后勾选集里可能残留不可见项。
  const allChecked = visible.length > 0 && visible.every((p) => checkedPaperIds.includes(p.id));
  // 批量重试的候选：勾选中解析失败 / 尚未提交解析（有 PDF）的论文。
  const retryableCheckedIds = checkedPaperIds.filter((id) => {
    const paper = intake.find((p) => p.id === id);
    return Boolean(paper?.pdfPath) && (paper?.mineruStatus === "error" || paper?.mineruStatus === "pending");
  });
  const retryableCheckedCount = retryableCheckedIds.length;
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
          {/* 首次导入引导卡：只出现一次（可收起），给出两条下一步。 */}
          {mode === "intake" &&
          !intakeGuideDismissed &&
          localStorage.getItem("paper-field.has-imported") === "1" &&
          intake.length ? (
            <div className="ef-intake-guide" aria-label="首次导入引导">
              <p>第一次导入完成。论文正在排队解析；解析完成后就可以开始读。</p>
              <div className="ef-guide-actions">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    const first =
                      intake.find((p) => p.mineruStatus === "done") ??
                      intake.find((p) => p.pdfPath) ??
                      intake[0];
                    if (first) void openPaperFulltext(first.id);
                  }}
                >
                  开始读第一篇
                </Button>
                <Button type="button" size="sm" onClick={() => openSystemCard("mineru")}>
                  检查解析源
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="text"
                  onClick={() => {
                    try {
                      localStorage.setItem("paper-field.intake-guide-dismissed", "1");
                    } catch {
                      // 存不下：本次会话内仍然收起。
                    }
                    setIntakeGuideDismissed(true);
                  }}
                >
                  不再显示
                </Button>
              </div>
            </div>
          ) : null}
          {/* 入库漏斗：今日导入 / 解析中 / 排队 / 待读 / 失败，计数可点即筛选；
              全库待处理 vs 当前命中并排可见（搜索与分组筛选都会改写「当前命中」）。 */}
          <div className="ef-intake-funnel" aria-label="入库漏斗统计">
            <span>
              今日导入 <b className="mono">{todayImportedCount}</b>
            </span>
            <button type="button" onClick={() => setIntakeStage("parsing")} title="只看解析中的论文">
              解析中 <b className="mono">{intakeStageCounts.get("parsing") ?? 0}</b>
            </button>
            <button type="button" onClick={() => setIntakeStage("queued")} title="只看排队中的论文">
              排队 <b className="mono">{intakeStageCounts.get("queued") ?? 0}</b>
            </button>
            <button type="button" onClick={() => setIntakeStage("ready")} title="只看已解析待读的论文">
              待读 <b className="mono">{intakeStageCounts.get("ready") ?? 0}</b>
            </button>
            <button
              type="button"
              className="ef-funnel-error"
              onClick={() => setIntakeStage("error")}
              title="只看解析失败的论文"
            >
              失败 <b className="mono">{failedParseCount}</b>
            </button>
            <span className="ef-funnel-scope">
              全库待处理 {intake.length} · 当前命中 {visible.length}
            </span>
            {failedParseCount ? (
              <Button
                type="button"
                size="sm"
                title="先看影响篇数与清单，再决定是否全部重试"
                onClick={() => openDialog("confirm-retry")}
              >
                全部重试
              </Button>
            ) : null}
          </div>
          {failedParseCount ? (
            <div className="ef-failure-panel">
              <Button
                type="button"
                size="sm"
                variant="text"
                aria-expanded={failuresOpen}
                onClick={() => setFailuresOpen((open) => !open)}
              >
                {failuresOpen ? "收起失败原因" : `查看失败原因（${failedParseCount}）`}
              </Button>
              {failuresOpen ? (
                <div className="ef-failure-clusters">
                  {failureClusters.map(([key, papers]) => {
                    const category = classifyParseError(papers[0]?.mineruError);
                    return (
                      <div key={key} className="ef-failure-cluster">
                        <div className="ef-failure-cluster-head">
                          <b>{category.label} · {papers.length} 篇</b>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => void retryMineruPapers(papers.map((p) => p.id))}
                          >
                            重试此类
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="text"
                            onClick={() => openSystemCard(category.anchor)}
                          >
                            查看解决办法
                          </Button>
                        </div>
                        <p className="ef-failure-advice">{category.advice}</p>
                        <ul>
                          {papers.map((paper) => (
                            <li key={paper.id}>
                              <span>{paper.titleZh || paper.title}</span>
                              <span className="ef-failure-reason">{parseErrorSummary(paper.mineruError)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              ) : null}
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
          <Button
            type="button"
            size="sm"
            className={archiveView.searchNotes ? "is-active" : ""}
            aria-pressed={archiveView.searchNotes}
            title="搜索时同时匹配五块笔记的内容（行内显示命中片段）"
            onClick={() => setArchiveView({ searchNotes: !archiveView.searchNotes })}
          >
            含笔记
          </Button>
          <Button
            type="button"
            size="sm"
            className={archiveView.searchFulltext ? "is-active" : ""}
            aria-pressed={archiveView.searchFulltext}
            title="搜索时同时匹配 MinerU 解析出的全文（行内显示命中片段）"
            onClick={() => setArchiveView({ searchFulltext: !archiveView.searchFulltext })}
          >
            含全文
          </Button>
        </div>
      ) : null}

      {mode === "intake" && intake.length ? (
        <div className="filter-row" role="group" aria-label="按解析状态分组">
          {INTAKE_STAGES.map((item) => (
            <Button
              key={item.value}
              type="button"
              size="sm"
              className={intakeStage === item.value ? "is-active" : ""}
              aria-pressed={intakeStage === item.value}
              onClick={() => setIntakeStage(item.value)}
            >
              {item.value === "all" ? `全部 ${intake.length}` : `${item.label} ${intakeStageCounts.get(item.value) ?? 0}`}
            </Button>
          ))}
        </div>
      ) : null}

      {mode === "intake" && intake.length ? (
        <div className="ef-archive-tools" role="group" aria-label="入库组合筛选">
          <label className="ef-tool-select">
            <span>领域</span>
            <select
              aria-label="按领域筛选入库"
              value={intakeView.domainId ?? ""}
              onChange={(e) => setIntakeView({ domainId: e.target.value || null })}
            >
              <option value="">全部领域</option>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="ef-tool-select">
            <span>入库日期</span>
            <select
              aria-label="按入库日期筛选"
              value={intakeView.period}
              onChange={(e) => setIntakeView({ period: e.target.value as IntakeView["period"] })}
            >
              {INTAKE_PERIODS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="ef-tool-select">
            <span>解析源</span>
            <select
              aria-label="按解析源筛选"
              value={intakeView.provider}
              onChange={(e) => setIntakeView({ provider: e.target.value })}
            >
              <option value="">全部解析源</option>
              {[...new Set(intake.map((p) => p.mineruProvider ?? "").filter(Boolean))].map((provider) => (
                <option key={provider} value={provider}>
                  {PROVIDER_LABELS[provider] ?? provider}
                </option>
              ))}
              {intake.some((p) => !p.mineruProvider) ? <option value="__none__">未记录来源</option> : null}
            </select>
          </label>
          <Button
            type="button"
            size="sm"
            variant="text"
            title="清空领域 / 日期 / 解析源条件（保留解析状态分组）"
            onClick={() => setIntakeView(DEFAULT_INTAKE_VIEW)}
          >
            清空条件
          </Button>
        </div>
      ) : null}

      {mode === "intake" ? (
        <div className="ef-job-list">
          {/* 只显示进行中的作业：完成/失败的历史堆在这里会刷屏（曾经的「MinerU 解析 · 完成」墙），
              结果通知走右上角弹窗，失败可重试的入口在下方「解析失败 · N 篇」。
              行内文案与作业面板同一口径：标题 + 阶段一句话，点击在面板里高亮对应作业卡。
              超过 6 条时先截断，可「就地展开」看全，不必跳去作业面板。 */}
          {activeJobs
            .slice(0, jobsExpanded ? undefined : 6)
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
          {activeJobs.length > 6 ? (
            <Button
              type="button"
              size="sm"
              variant="text"
              className="ef-jobs-expand"
              aria-expanded={jobsExpanded}
              onClick={() => setJobsExpanded((open) => !open)}
            >
              {jobsExpanded
                ? "收起进行中作业"
                : `另有 ${activeJobs.length - 6} 条进行中作业 · 就地展开`}
            </Button>
          ) : null}
          {activeJobs.length === 0 ? (
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
              {mode === "intake" ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={retryableCheckedCount === 0}
                  title={
                    retryableCheckedCount
                      ? `把勾选中解析失败 / 尚未提交的 ${retryableCheckedCount} 篇重新提交解析`
                      : "勾选解析失败或尚未提交解析的论文后可用"
                  }
                  onClick={() => void retryMineruPapers(retryableCheckedIds)}
                >
                  重试所选（{retryableCheckedCount}）
                </Button>
              ) : null}
              {mode === "archive" ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    disabled={checkedPaperIds.length < 2}
                    title="勾选至少两篇已读论文后，生成五块笔记对照表"
                    onClick={() => openDialog("compare-notes")}
                  >
                    对照表
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!checkedPaperIds.length}
                    title="把勾选的论文导出为 Markdown / BibTeX"
                    onClick={() => openDialog("export-checked")}
                  >
                    导出所选
                  </Button>
                </>
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
        ) : mode === "intake" && !search.trim() && intake.length === 0 && activeJobs.length === 0 ? (
          <IntakeClearedGuide />
        ) : (
          <p className="no-results">
            {search.trim()
              ? "没有符合条件的论文。可以调整搜索词或切换领域。"
              : mode === "archive"
                ? archive.length
                  ? "没有符合条件的已读论文。可以调整上方的领域 / 年份筛选或开源状态。"
                  : "还没有手动标记已读的论文。"
                : mode === "intake"
                  ? intake.length
                    ? "当前筛选下没有论文。可以切换上方的解析状态分组或调整搜索词。"
                    : "没有待处理论文。"
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
          rowExtra={mode === "archive" ? archiveRowExtra : mode === "intake" ? intakeRowExtra : undefined}
        />
      )}

      {/* 「暂缓处理」：被放一放的失败论文折叠在此，不占主视野；可恢复。 */}
      {mode === "intake" && deferredIds.length ? (
        <details className="ef-deferred">
          <summary aria-label={`展开暂缓处理区（${deferredIds.length} 篇）`}>
            暂缓处理 · {deferredIds.length} 篇
          </summary>
          <ul>
            {[...deferredById.values()].map((paper) => (
              <li key={paper.id}>
                <span className="ef-deferred-title">{paper.titleZh || paper.title}</span>
                <span className="ef-failure-reason">{parseErrorSummary(paper.mineruError, 24)}</span>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    undeferPaper(paper.id);
                    setDeferredVersion((v) => v + 1);
                  }}
                >
                  恢复处理
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* 「接下来读」：个人阅读安排（与技术解析队列分开展示）。建议 = 已解析完成里
          最早导入的一篇；队列本机记录、可手动排序；点标题直接进入阅读页。 */}
      {mode === "intake" && (readNextSuggestion || readNextIds.length) ? (
        <div className="ef-readnext" aria-label="接下来读">
          {readNextSuggestion ? (
            <div className="ef-readnext-suggest">
              <span className="ef-readnext-label">下一篇建议</span>
              <button
                type="button"
                className="ef-readnext-title"
                title="开始阅读这篇（进入解析全文阅读页）"
                onClick={() => void openPaperFulltext(readNextSuggestion.id)}
              >
                {readNextSuggestion.titleZh || readNextSuggestion.title}
              </button>
              <Button type="button" size="sm" onClick={() => void openPaperFulltext(readNextSuggestion.id)}>
                开始阅读
              </Button>
            </div>
          ) : null}
          {readNextIds.length ? (
            <div className="ef-readnext-queue">
              <span className="ef-readnext-label">接下来读 · {readNextIds.length}</span>
              <ol>
                {readNextIds.map((id, index) => {
                  const paper = readNextById.get(id);
                  if (!paper) return null;
                  return (
                    <li key={id}>
                      <span className="mono ef-readnext-index">{index + 1}</span>
                      <button
                        type="button"
                        className="ef-readnext-title"
                        title="开始阅读这篇"
                        onClick={() => void openPaperFulltext(id)}
                      >
                        {paper.titleZh || paper.title}
                      </button>
                      <span className="ef-readnext-actions">
                        <button
                          type="button"
                          aria-label={`置顶 ${paper.titleZh || paper.title}`}
                          title="置顶"
                          disabled={index === 0}
                          onClick={() => {
                            readNextMove(id, "top");
                            bumpReadNext();
                          }}
                        >
                          ⤒
                        </button>
                        <button
                          type="button"
                          aria-label={`上移 ${paper.titleZh || paper.title}`}
                          title="上移"
                          disabled={index === 0}
                          onClick={() => {
                            readNextMove(id, "up");
                            bumpReadNext();
                          }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`移出 ${paper.titleZh || paper.title}`}
                          title="移出队列"
                          onClick={() => {
                            readNextRemove(id);
                            bumpReadNext();
                          }}
                        >
                          <Icon name="close" />
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : null}
        </div>
      ) : null}

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
