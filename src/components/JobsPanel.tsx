import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { getActivity, subscribeActivity } from "../lib/activity";
import {
  deriveJobsView,
  formatClock,
  formatElapsed,
  formatEta,
  formatSpan,
  type ActiveJobView,
  type BatchView,
  type HistoryItemView,
  type QueueItemView,
  type SegmentState,
} from "../lib/jobsView";
import { repo } from "../lib/repo";
import type { LlmProviderView, PaperBrief } from "../lib/types";
import { pad2, shortcut } from "../lib/util";
import { useField } from "../store";
import { Button, Icon } from "./ui";

/** 逐篇色块超过该数时改用连续分段条（色块太窄就失去「一篇一格」的意义）。 */
const SEGMENT_LIMIT = 48;
/** 排队列表默认展示条数，其余折叠为「还有 N 篇」。 */
const QUEUE_PREVIEW = 6;

const SEGMENT_LABELS: Record<SegmentState, string> = {
  ok: "已完成",
  fail: "失败",
  cancelled: "已取消",
  skip: "已跳过",
  current: "处理中",
  pending: "排队",
  paused: "已暂停",
};

const BATCH_STATE_LABELS: Record<BatchView["state"], string> = {
  waiting: "等待",
  running: "进行中",
  done: "已完成",
  halted: "已暂停",
};

/** 运行中每秒走一次表；空闲时停表，不做无意义的重渲染。 */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

/**
 * 批次里排队论文的标题与领域：只查需要的列。store 每次刷新（jobs 换新数组）重查一次，
 * AI 补全把文件名换成真实标题后，面板随之更新。
 */
function usePaperBriefs(ids: string[], refreshKey: unknown): Record<string, PaperBrief> {
  const key = [...new Set(ids)].sort().join(",");
  const [briefs, setBriefs] = useState<Record<string, PaperBrief>>({});
  useEffect(() => {
    if (!key) return;
    let alive = true;
    // Promise.resolve().then 把同步抛错也收进 catch：标题只是展示用，查不到就用短编号兜底。
    Promise.resolve()
      .then(() => repo.paperBriefs(key.split(",")))
      .then((rows) => {
        if (alive) setBriefs(Object.fromEntries(rows.map((row) => [row.id, row])));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [key, refreshKey]);
  return briefs;
}

/** 与 hasUsableProvider 同一口径的可用提供商（顺序即回退顺序）。 */
function usableProviders(providers: LlmProviderView[]): LlmProviderView[] {
  return providers.filter((provider) => provider.enabled && (!provider.requiresKey || provider.hasKey));
}

export function JobsPanel() {
  const open = useField((s) => s.jobsOpen);
  return open ? <JobsPanelBody /> : null;
}

function JobsPanelBody() {
  const jobs = useField((s) => s.jobs);
  const settings = useField((s) => s.settings);
  const setJobsOpen = useField((s) => s.setJobsOpen);
  const landOnPaper = useField((s) => s.landOnPaper);
  const activity = useSyncExternalStore(subscribeActivity, getActivity);
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);

  const batchPaperIds = useMemo(() => activity.batches.flatMap((batch) => batch.paperIds), [activity.batches]);
  const briefs = usePaperBriefs(batchPaperIds, jobs);
  const ticking =
    jobs.some((job) => job.status === "queued" || job.status === "running") ||
    activity.batches.some((batch) => batch.state === "running" || batch.state === "waiting");
  const now = useNow(ticking);
  const view = useMemo(() => deriveJobsView({ jobs, activity, briefs, now }), [jobs, activity, briefs, now]);
  const llmChain = usableProviders(settings.providers);

  // 非模态浮层：打开时把焦点交给面板（读屏播报标题），关闭后还给状态条入口。
  useEffect(() => {
    const panel = panelRef.current;
    panel?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || panel?.contains(active)) {
        document.getElementById("jobs-toggle")?.focus({ preventScroll: true });
      }
    };
  }, []);

  async function jump(paperId: string, domainId: string | null) {
    await landOnPaper(paperId, domainId);
  }

  const { counts } = view;

  return (
    <section
      ref={panelRef}
      id="jobs-panel"
      className="ef-jobs"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <header className="ef-jobs-head">
        <h2 id={titleId}>
          <Icon name="activity" />
          作业面板
        </h2>
        <span className={`ef-jobs-state ${view.busy ? "is-busy" : ""}`.trim()}>
          {view.busy ? <i className="ef-pulse" aria-hidden="true" /> : null}
          {view.busy ? "运行中" : "空闲"}
        </span>
        <span className="ef-jobs-spacer" />
        <span className="kbd" aria-hidden="true">
          {shortcut("J")}
        </span>
        <Button
          type="button"
          variant="text"
          className="ef-icon-btn"
          aria-label="关闭作业面板"
          onClick={() => setJobsOpen(false)}
        >
          <Icon name="close" />
        </Button>
      </header>

      <dl className="ef-jobs-plate" aria-label="作业计数">
        <div className={counts.running ? "is-live" : ""}>
          <dt>运行中</dt>
          <dd className="mono">{counts.running}</dd>
        </div>
        <div>
          <dt>排队</dt>
          <dd className="mono">{counts.queued}</dd>
        </div>
        <div title="自本次启动以来">
          <dt>本次完成</dt>
          <dd className="mono">{counts.done}</dd>
        </div>
        <div className={counts.failed ? "is-error" : ""} title="自本次启动以来">
          <dt>本次失败</dt>
          <dd className="mono">{counts.failed}</dd>
        </div>
      </dl>

      <div className="ef-jobs-scroll">
        {view.batch ? <BatchCard batch={view.batch} /> : null}
        {view.waitingBatches.count ? (
          <p className="ef-jobs-note">
            另有 {view.waitingBatches.count} 个批次（{view.waitingBatches.papers} 篇）在后面排队，当前批次结束后依次开始。
          </p>
        ) : null}

        <section className="ef-jobs-section" aria-label="进行中的作业">
          <h3 className="ef-jobs-sub">
            进行中
            <span className="ef-count mono">{pad2(view.active.length)}</span>
          </h3>
          {view.active.length ? (
            view.active.map((job, index) => (
              <JobCard key={job.id} job={job} index={index} llmChain={llmChain} onJump={jump} />
            ))
          ) : (
            <div className="ef-jobs-idle">
              <strong>{view.queue.length ? "正在准备下一篇" : "队列空闲"}</strong>
              <p>导入 PDF、重新解析或运行 AI 助手后，每一步的进度都会显示在这里。</p>
            </div>
          )}
        </section>

        {view.queue.length ? <QueueList queue={view.queue} onJump={jump} /> : null}

        <HistoryList history={view.history} now={now} onJump={jump} />
      </div>
    </section>
  );
}

function BatchCard({ batch }: { batch: BatchView }) {
  const stopMineruBatch = useField((s) => s.stopMineruBatch);
  const [confirmStop, setConfirmStop] = useState(false);
  const running = batch.state === "running";
  const summary = [
    `成功 ${batch.ok}`,
    batch.fail ? `失败 ${batch.fail}` : null,
    batch.cancelled ? `取消 ${batch.cancelled}` : null,
    batch.skipped ? `跳过 ${batch.skipped}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const unfinished = batch.total - batch.processed;
  return (
    <article className={`ef-batchcard is-${batch.state}`} aria-label={`${batch.label}批次`}>
      <header className="ef-batchcard-head">
        <span className="ef-code">{batch.kind === "mineru" ? "MINERU" : "AI"}</span>
        <h3>{batch.label}批次</h3>
        <span className="ef-batchcard-state">{BATCH_STATE_LABELS[batch.state]}</span>
        <span className="ef-batchcard-num mono">
          <b>{batch.processed}</b> / {batch.total} 篇
        </span>
      </header>

      {batch.total <= SEGMENT_LIMIT ? (
        <ol
          className="ef-segments"
          style={{ "--pf-seg-count": batch.total } as CSSProperties}
          role="img"
          aria-label={`逐篇进度：已处理 ${batch.processed} / ${batch.total} 篇，${summary}`}
        >
          {batch.segments.map((segment, index) => (
            <li
              key={segment.paperId}
              className={`is-${segment.state}`}
              title={`${pad2(index + 1)} · ${segment.title} — ${SEGMENT_LABELS[segment.state]}`}
            />
          ))}
        </ol>
      ) : (
        <div
          className="ef-segbar"
          role="img"
          aria-label={`逐篇进度：已处理 ${batch.processed} / ${batch.total} 篇，${summary}`}
        >
          {(["ok", "fail", "cancelled", "skip"] as const).map((key) => {
            const count = batch.segments.filter((segment) => segment.state === key).length;
            return count ? (
              <i key={key} className={`is-${key}`} style={{ width: `${(count / batch.total) * 100}%` }} />
            ) : null;
          })}
          {batch.currentPaperId ? <i className="is-current" style={{ width: `${100 / batch.total}%` }} /> : null}
        </div>
      )}

      <p className="ef-batchcard-stats">
        <span>{summary}</span>
        {running && batch.pending ? <span>排队 {batch.pending}</span> : null}
        <span className="mono">用时 {formatElapsed(batch.elapsedMs)}</span>
        {running ? (
          <span>{batch.etaMs !== null ? `预计还需 ${formatEta(batch.etaMs)}` : "完成首篇后估算剩余时间"}</span>
        ) : null}
      </p>

      {batch.state === "halted" && unfinished > 0 ? (
        <p className="ef-batchcard-alert">
          已暂停，剩余 {unfinished} 篇未处理。解析源可能繁忙或不可用，可在设置页测试连接后到入库页重试。
        </p>
      ) : null}

      {running && batch.kind === "mineru" && (batch.pending || batch.currentPaperId) ? (
        <div className="ef-batchcard-actions">
          {confirmStop ? (
            <>
              <span>停止后，正在解析的一篇会取消，其余排队论文不再提交。</span>
              <Button
                type="button"
                size="sm"
                className="ef-btn-danger-solid"
                onClick={() => {
                  setConfirmStop(false);
                  void stopMineruBatch(batch.id);
                }}
              >
                确认停止
              </Button>
              <Button type="button" size="sm" variant="text" onClick={() => setConfirmStop(false)}>
                继续解析
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" variant="danger" onClick={() => setConfirmStop(true)}>
              停止本批…
            </Button>
          )}
        </div>
      ) : null}
    </article>
  );
}

function JobCard({
  job,
  index,
  llmChain,
  onJump,
}: {
  job: ActiveJobView;
  index: number;
  llmChain: LlmProviderView[];
  onJump: (paperId: string, domainId: string | null) => Promise<void>;
}) {
  const cancelJob = useField((s) => s.cancelJob);
  const isMineru = job.type === "mineruParse";
  // AI 作业的去向：可用提供商的首选（失败时按设置页顺序回退）。
  const via = isMineru
    ? job.provider
    : llmChain.length
      ? `${llmChain[0].label}${llmChain[0].model ? `（${llmChain[0].model}）` : ""}${
          llmChain.length > 1 ? ` · 失败时回退其余 ${llmChain.length - 1} 个` : ""
        }`
      : null;
  const pagePct = job.pages ? Math.round((job.pages.done / job.pages.total) * 100) : null;
  return (
    <article
      className={`ef-jobcard is-${job.status} pf-stagger`}
      style={{ "--pf-i": index } as CSSProperties}
      aria-label={`${job.typeLabel}：${job.title}`}
    >
      <div className="ef-jobcard-top">
        <span className="ef-jobcard-type">
          <Icon name={isMineru ? "file" : "spark"} />
          {job.typeLabel}
        </span>
        {job.auto ? <span className="ef-jobcard-tag">解析后自动</span> : null}
        <span className="ef-jobcard-time mono" title={job.status === "running" ? "已运行" : "已等待"}>
          {formatElapsed(job.elapsedMs)}
        </span>
        <Button type="button" size="sm" variant="text" onClick={() => void cancelJob(job.id)}>
          取消
        </Button>
      </div>
      <button
        type="button"
        className="ef-jobcard-title"
        title="在阅读页打开这篇论文"
        onClick={() => void onJump(job.paperId, job.domainId)}
      >
        {job.title}
      </button>
      {job.domainName || via ? (
        <p className="ef-jobcard-meta">{[job.domainName, via].filter(Boolean).join(" · ")}</p>
      ) : null}

      <ol className="ef-steps" aria-label="作业阶段">
        {job.steps.map((step, i) => (
          <li
            key={step.key}
            className={`is-${step.state}`}
            aria-current={step.state === "current" ? "step" : undefined}
          >
            <span className="ef-step-mark mono" aria-hidden="true">
              {step.state === "done" ? <Icon name="check" /> : pad2(i + 1)}
            </span>
            <span className="ef-step-label">{step.label}</span>
          </li>
        ))}
      </ol>

      <div className="ef-jobcard-progress">
        {job.pages && pagePct !== null ? (
          <div
            className="ef-progress"
            role="progressbar"
            aria-label="解析页进度"
            aria-valuemin={0}
            aria-valuemax={job.pages.total}
            aria-valuenow={job.pages.done}
          >
            <i style={{ width: `${pagePct}%` }} />
          </div>
        ) : job.status === "running" ? (
          <div className="pf-sweep" aria-hidden="true" />
        ) : (
          <div className="ef-progress is-idle" aria-hidden="true" />
        )}
        <p className="ef-jobcard-hint">
          <span>{job.stageHint}</span>
          {job.stageElapsedMs !== null ? (
            <span className="mono">本阶段 {formatElapsed(job.stageElapsedMs)}</span>
          ) : null}
        </p>
      </div>
    </article>
  );
}

function QueueList({
  queue,
  onJump,
}: {
  queue: QueueItemView[];
  onJump: (paperId: string, domainId: string | null) => Promise<void>;
}) {
  const dequeueMineruPaper = useField((s) => s.dequeueMineruPaper);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? queue : queue.slice(0, QUEUE_PREVIEW);
  const hidden = queue.length - shown.length;
  return (
    <section className="ef-jobs-section" aria-label="排队中的论文">
      <h3 className="ef-jobs-sub">
        排队
        <span className="ef-count mono">{pad2(queue.length)}</span>
      </h3>
      <ol className="ef-queue">
        {shown.map((item, index) => (
          <li key={item.paperId} className={`ef-queue-row${index === 0 && !item.waiting ? " is-next" : ""}`}>
            <span className="ef-queue-index mono">{pad2(index + 1)}</span>
            <button
              type="button"
              className="ef-queue-title"
              title="在阅读页打开这篇论文"
              onClick={() => void onJump(item.paperId, item.domainId)}
            >
              {item.title}
            </button>
            <span className="ef-queue-meta">
              {index === 0 && !item.waiting ? "下一篇" : item.waiting ? "下一批" : "排队"}
              {item.kind === "mineru" ? " · 待解析" : " · 待补全"}
            </span>
            {item.kind === "mineru" ? (
              <button
                type="button"
                className="ef-queue-remove"
                aria-label={`移出队列：${item.title}`}
                title="移出队列（不提交解析）"
                onClick={() => dequeueMineruPaper(item.batchId, item.paperId)}
              >
                <Icon name="close" />
              </button>
            ) : null}
          </li>
        ))}
      </ol>
      {hidden > 0 || expanded ? (
        <Button
          type="button"
          size="sm"
          variant="text"
          className="ef-queue-more"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : `还有 ${hidden} 篇`}
          <Icon name={expanded ? "up" : "down"} />
        </Button>
      ) : null}
    </section>
  );
}

const HISTORY_MARKS: Record<HistoryItemView["status"], "check" | "close" | "minus"> = {
  done: "check",
  error: "close",
  cancelled: "minus",
};

const HISTORY_STATUS: Record<HistoryItemView["status"], string> = {
  done: "完成",
  error: "失败",
  cancelled: "取消",
};

function HistoryList({
  history,
  now,
  onJump,
}: {
  history: HistoryItemView[];
  now: number;
  onJump: (paperId: string, domainId: string | null) => Promise<void>;
}) {
  const retryMineru = useField((s) => s.retryMineru);
  return (
    <section className="ef-jobs-section" aria-label="最近结束的作业">
      <h3 className="ef-jobs-sub">
        最近结束
        <span className="ef-count mono">{pad2(history.length)}</span>
      </h3>
      {history.length ? (
        <ol className="ef-history">
          {history.map((item) => (
            <li key={item.id} className={`ef-hist-row is-${item.status}`}>
              <span className="ef-hist-mark" aria-hidden="true">
                <Icon name={HISTORY_MARKS[item.status]} />
              </span>
              <div className="ef-hist-main">
                <p className="ef-hist-line">
                  <span className="sr-only">{HISTORY_STATUS[item.status]}：</span>
                  <b>{item.typeLabel}</b>
                  <button
                    type="button"
                    className="ef-hist-title"
                    title="在阅读页打开这篇论文"
                    onClick={() => void onJump(item.paperId, item.domainId)}
                  >
                    {item.title}
                  </button>
                </p>
                {item.note ? (
                  <p className="ef-hist-note" title={item.note}>
                    {item.note}
                  </p>
                ) : null}
              </div>
              <span className="ef-hist-side">
                <span title="结束时间">{formatClock(item.finishedAt, now)}</span>
                <span title="用时">{item.durationMs !== null ? `用时 ${formatSpan(item.durationMs)}` : "—"}</span>
              </span>
              {item.retryable ? (
                <Button
                  type="button"
                  size="sm"
                  className="ef-hist-retry"
                  onClick={() => void retryMineru(item.paperId)}
                >
                  重新解析
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="ef-jobs-empty">还没有结束的作业。</p>
      )}
    </section>
  );
}
