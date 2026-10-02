import {
  JOB_STATUS_LABELS,
  JOB_TYPE_LABELS,
  type OpenSource,
} from "../lib/types";
import { pad2 } from "../lib/util";
import { useField } from "../store";
import { PaperMatrix } from "./PaperMatrix";
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
  const search = useField((s) => s.search);

  const domain = domains.find((d) => d.id === selectedDomainId) ?? null;
  const list = mode === "archive" ? archive : mode === "intake" ? intake : papers;
  const domainRead = papers.filter((p) => p.readingStatus === "read").length;
  const fill = papers.length ? domainRead / papers.length : 0;

  return (
    <aside className="ef-nav" aria-label="领域与论文列表">
      {mode === "field" ? (
        <div className="ef-nav-head">
          <div className="ef-overline">FIELD / {domain?.code ?? "—"}</div>
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
            <span>
              已读 {domainRead} / {papers.length}
            </span>
          </div>
          <div className="ef-progress" aria-hidden="true">
            <i style={{ width: `${Math.round(fill * 100)}%` }} />
          </div>
        </div>
      ) : null}

      {mode === "archive" ? (
        <div className="ef-nav-head">
          <div className="ef-overline">ARCHIVE</div>
          <div className="ef-domain-picker">
            <h2>归档</h2>
          </div>
          <p className="ef-nav-sum">只有你手动标记已读的论文会出现在这里。AI 不会自动标记已读。</p>
        </div>
      ) : null}

      {mode === "intake" ? (
        <div className="ef-nav-head">
          <div className="ef-overline">INTAKE</div>
          <div className="ef-domain-picker">
            <h2>入库</h2>
          </div>
          <p className="ef-nav-sum">尚未读完的论文，以及 MinerU 解析和 AI 补全作业。</p>
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
          {jobs.slice(0, 6).map((job) => (
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
          {jobs.length === 0 ? <p className="ef-nav-sum">当前没有 AI 作业。</p> : null}
        </div>
      ) : null}

      <div className="ef-list-head">
        <span>
          {mode === "archive" ? "已读归档 · 全部领域" : mode === "intake" ? "待处理论文" : "本领域论文"}
        </span>
        <span className="mono">{pad2(list.length)}</span>
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
