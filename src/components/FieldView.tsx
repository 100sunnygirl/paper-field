import { pad2 } from "../lib/util";
import { useField } from "../store";
import { PaperMatrix } from "./PaperMatrix";
import { Button, Empty } from "./ui";

export function PaperNav() {
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

  const domain = domains.find((d) => d.id === selectedDomainId) ?? null;
  const index = Math.max(1, domains.findIndex((d) => d.id === selectedDomainId) + 1);
  const list = mode === "archive" ? archive : mode === "intake" ? intake : papers;
  const domainRead = papers.filter((p) => p.readingStatus === "read").length;
  const fill = papers.length ? domainRead / papers.length : 0;

  return (
    <aside className="ef-nav" aria-label="Paper navigator">
      <div className="ef-cal" aria-hidden="true">
        {Array.from({ length: 16 }, (_, i) => (
          <i key={i} />
        ))}
        <div className="ef-cal-fill" style={{ height: `${Math.round(fill * 100)}%` }} />
      </div>
      <div className="ef-nav-body">
        {mode === "field" ? (
          <>
            <p className="ef-kicker">
              {domain?.code ?? "—"} · {pad2(index)} · {domainRead}/{papers.length}
            </p>
            <h2 className="ef-nav-title">{domain?.name ?? "NO FIELD"}</h2>
            <p className="ef-nav-sum">{domain?.summary ?? "选择或创建领域"}</p>
            <div className="ef-nav-actions">
              <Button primary type="button" onClick={() => openDialog("paper")}>
                + PAPER
              </Button>
            </div>
          </>
        ) : null}
        {mode === "archive" ? (
          <>
            <p className="ef-kicker">Archive / read library</p>
            <h2 className="ef-nav-title">归档</h2>
            <div className="filter-row" style={{ marginBottom: 8 }}>
              {(["all", "open", "closed", "request", "unknown"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`ef-btn ${archiveFilter === value ? "ink" : ""}`}
                  onClick={() => void setArchiveFilter(value === "all" ? "all" : value)}
                >
                  {value}
                </button>
              ))}
            </div>
          </>
        ) : null}
        {mode === "intake" ? (
          <>
            <p className="ef-kicker">Intake / LLM queue</p>
            <h2 className="ef-nav-title">入库</h2>
            <div className="ef-nav-jobs">
              {jobs.slice(0, 4).map((job) => (
                <div key={job.id} className="job-row">
                  <span>
                    {job.status === "running" ? <i className="ef-pulse" /> : null}
                    {job.type} · {job.status}
                  </span>
                  {job.status === "running" || job.status === "queued" ? (
                    <button type="button" className="ef-btn" onClick={() => void cancelJob(job.id)}>
                      CANCEL
                    </button>
                  ) : null}
                </div>
              ))}
              {jobs.length === 0 ? <p className="ef-nav-sum">队列空闲</p> : null}
            </div>
          </>
        ) : null}

        {list.length === 0 ? (
          <Empty
            title={mode === "archive" ? "No read units" : mode === "intake" ? "Intake clear" : "No unit"}
            body={
              mode === "archive"
                ? "只有手动 MARK READ 的论文会出现在这里。"
                : mode === "intake"
                  ? "没有待处理论文。"
                  : "向该领域投放第一篇论文。"
            }
          />
        ) : (
          <PaperMatrix
            compact
            papers={list}
            selectedId={selectedPaperId}
            onSelect={(id) => void selectPaper(id)}
          />
        )}
      </div>
    </aside>
  );
}
