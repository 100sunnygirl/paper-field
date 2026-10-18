import { useEffect, useState } from "react";
import {
  JOB_STATUS_LABELS,
  JOB_TYPE_LABELS,
  type OpenSource,
  type PaperListItem,
} from "../lib/types";
import { repo } from "../lib/repo";
import { pad2, shortcut } from "../lib/util";
import { useField } from "../store";
import { CheckSquare, PaperMatrix } from "./PaperMatrix";
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
  const [censusEpoch, setCensusEpoch] = useState(0);

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
  const domainPapers =
    mode === "field" && domainCensus?.domainId === selectedDomainId ? domainCensus.items : papers;
  void censusEpoch;
  const failedParseCount = intake.filter((p) => p.mineruStatus === "error").length;
  const domainRead = domainPapers.filter((p) => p.readingStatus === "read").length;
  const fill = domainPapers.length ? domainRead / domainPapers.length : 0;
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
              已读 <b className="mono">{domainRead}</b>
              <span className="mono"> / {domainPapers.length}</span>
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
              <span className="ef-count mono">{pad2(mode === "field" ? domainPapers.length : list.length)}</span>
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
                  批量
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
                : "此领域还没有论文。"}
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
