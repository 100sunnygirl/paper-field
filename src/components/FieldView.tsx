import { useEffect } from "react";
import {
  JOB_STATUS_LABELS,
  JOB_TYPE_LABELS,
  type OpenSource,
} from "../lib/types";
import { pad2 } from "../lib/util";
import { useField } from "../store";
import { CheckSquare, PaperMatrix } from "./PaperMatrix";
import { Button, Icon } from "./ui";

const ARCHIVE_FILTERS: Array<{ value: OpenSource | "all"; label: string }> = [
  { value: "all", label: "全部" },
  { value: "open", label: "开源" },
  { value: "closed", label: "闭源" },
  { value: "request", label: "需申请" },
  { value: "unknown", label: "未知" },
];

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
  const cancelJob = useField((s) => s.cancelJob);
  const retryFailedMineru = useField((s) => s.retryFailedMineru);
  const setJobsOpen = useField((s) => s.setJobsOpen);
  const search = useField((s) => s.search);
  const batchMode = useField((s) => s.batchMode);
  const checkedPaperIds = useField((s) => s.checkedPaperIds);
  const setBatchMode = useField((s) => s.setBatchMode);
  const toggleCheckedPaper = useField((s) => s.toggleCheckedPaper);
  const setCheckedPaperIds = useField((s) => s.setCheckedPaperIds);

  const domain = domains.find((d) => d.id === selectedDomainId) ?? null;
  const list = mode === "archive" ? archive : mode === "intake" ? intake : papers;
  const failedParseCount = intake.filter((p) => p.mineruStatus === "error").length;
  const domainRead = papers.filter((p) => p.readingStatus === "read").length;
  const fill = papers.length ? domainRead / papers.length : 0;
  const allChecked = list.length > 0 && checkedPaperIds.length === list.length;

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
          <div className="ef-domain-picker">
            <h2>{domain?.name ?? "未选择领域"}</h2>
            <button
              type="button"
              className="ef-domain-select"
              aria-label="切换研究领域"
              onClick={() => openDialog("pick-domain")}
            >
              <Icon name="down" />
            </button>
          </div>
          <p className="ef-nav-sum">{domain?.summary ?? "选择或创建领域，开始组织论文。"}</p>
          <div className="ef-progress-label">
            <span>阅读进度</span>
            <span className="ef-progress-value">
              已读 <b className="mono">{domainRead}</b>
              <span className="mono"> / {papers.length}</span>
            </span>
          </div>
          <div className="ef-progress" aria-hidden="true">
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
        </div>
      ) : null}

      {mode === "intake" ? (
        <div className="ef-nav-head">
          <div className="ef-overline">
            <span>全部领域 · 未读完</span>
          </div>
          <div className="ef-domain-picker">
            <h2>入库</h2>
          </div>
          <p className="ef-nav-sum">尚未读完的论文，以及 MinerU 解析和 AI 补全作业。</p>
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
        </div>
      ) : null}

      {mode === "intake" ? (
        <div className="ef-job-list">
          {/* 只显示进行中的作业：完成/失败的历史堆在这里会刷屏（曾经的「MinerU 解析 · 完成」墙），
              结果通知走右上角弹窗，失败可重试的入口在下方「解析失败 · N 篇」。 */}
          {jobs
            .filter((job) => job.status === "queued" || job.status === "running")
            .slice(0, 6)
            .map((job) => (
              <div key={job.id} className="ef-job-row">
                <span className={`status-${job.status}`}>
                  {job.status === "running" ? <i className="ef-pulse" aria-hidden="true" /> : null}
                  {JOB_TYPE_LABELS[job.type]} · {JOB_STATUS_LABELS[job.status]}
                </span>
                {job.status === "running" || job.status === "queued" ? (
                  <Button type="button" size="sm" onClick={() => void cancelJob(job.id)}>
                    取消
                  </Button>
                ) : null}
              </div>
            ))}
          {jobs.filter((job) => job.status === "queued" || job.status === "running").length === 0 ? (
            <p className="ef-nav-sum">当前没有进行中的 AI 作业。</p>
          ) : null}
          <Button type="button" variant="link" className="ef-jobs-link" onClick={() => setJobsOpen(true)}>
            在作业面板查看阶段与进度
            <Icon name="right" />
          </Button>
        </div>
      ) : null}

      <div className={`ef-list-head ${batchMode ? "is-batch" : ""}`.trim()}>
        {batchMode ? (
          <>
            <button
              type="button"
              className="ef-batch-all"
              role="checkbox"
              aria-checked={allChecked}
              onClick={() => setCheckedPaperIds(allChecked ? [] : list.map((p) => p.id))}
            >
              <CheckSquare on={allChecked} />
              全选
            </button>
            <span className="ef-batch-count mono" aria-live="polite">
              已选 {checkedPaperIds.length} / {list.length}
            </span>
            <span className="ef-batch-actions">
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
              <span className="ef-count mono">{pad2(list.length)}</span>
              {list.length ? (
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
                </Button>
              ) : null}
            </span>
          </>
        )}
      </div>

      {list.length === 0 ? (
        <p className="no-results">
          {search.trim()
            ? "没有符合条件的论文。可以调整搜索词或切换领域。"
            : mode === "archive"
              ? "还没有手动标记已读的论文。"
              : mode === "intake"
                ? "没有待处理论文。"
                : "向该领域投放第一篇论文。"}
        </p>
      ) : (
        <PaperMatrix
          papers={list}
          selectedId={selectedPaperId}
          onSelect={(id) => {
            void selectPaper(id);
            onPaperChosen?.();
          }}
          batch={batchMode}
          checkedIds={checkedPaperIds}
          onToggleCheck={(id) => toggleCheckedPaper(id)}
        />
      )}

      {mode === "field" ? (
        <div className="ef-nav-foot">
          <Button type="button" onClick={() => openDialog("pick-domain")}>
            <Icon name="grid" />
            切换研究领域
          </Button>
        </div>
      ) : null}
    </aside>
  );
}
