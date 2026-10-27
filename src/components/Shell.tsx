import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { getActivity, subscribeActivity } from "../lib/activity";
import { deriveJobsView } from "../lib/jobsView";
import { hasUsableProvider } from "../lib/settings";
import { repo } from "../lib/repo";
import {
  MINERU_PROVIDER_LABELS,
  MODE_LABELS,
  NOTE_DISPLAY_ORDER,
  NOTE_LABELS,
  type AppMode,
} from "../lib/types";
import { shortcut } from "../lib/util";
import { useField } from "../store";
import { Icon } from "./ui";

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

/**
 * 顶栏只放品牌。搜索与「添加论文」都作用于论文列表，放在列表栏里（PaperSearch /
 * PaperNav 底部），不在顶栏悬空。
 */
export function Dock() {
  return (
    <header className="ef-dock">
      <div className="ef-brand">
        <span className="ef-mark" aria-hidden="true" />
        <strong>PAPER FIELD</strong>
        <small>论文阅读工作台</small>
      </div>
    </header>
  );
}

/**
 * 状态条的作业入口：计数与作业面板同源（llm_jobs + 运行时实况），批次进行中时附一枚
 * 本批进度表；点击（或 ⌘J）展开作业面板，展开时入口亮起成「拉出的页签」。
 */
function JobsToggle() {
  const jobs = useField((s) => s.jobs);
  const jobsOpen = useField((s) => s.jobsOpen);
  const setJobsOpen = useField((s) => s.setJobsOpen);
  const activity = useSyncExternalStore(subscribeActivity, getActivity);
  // 状态条只用计数与批次进度，不需要走表（now 只影响用时类字段）。
  const view = useMemo(() => deriveJobsView({ jobs, activity, now: 0 }), [jobs, activity]);
  const { running, queued } = view.counts;
  const batch = view.batch?.state === "running" ? view.batch : null;
  const label = running ? `作业运行中 ${running}` : queued ? `作业等待 ${queued}` : "队列空闲";
  const className = ["ef-status-jobs", running || queued ? "busy" : "", jobsOpen ? "is-open" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={className}>
      <button
        id="jobs-toggle"
        type="button"
        aria-expanded={jobsOpen}
        aria-controls={jobsOpen ? "jobs-panel" : undefined}
        title={`作业面板（${shortcut("J")}）`}
        onClick={() => setJobsOpen(!jobsOpen)}
      >
        {running ? <i className="ef-pulse" aria-hidden="true" /> : null}
        <span>{label}</span>
        {batch ? (
          <>
            <span className="ef-status-sep" aria-hidden="true">·</span>
            <span>
              {batch.label} <b>{batch.processed}</b>/{batch.total}
            </span>
            <span
              className="ef-status-meter"
              aria-hidden="true"
              style={{ "--pf-meter": `${batch.percent}%` } as CSSProperties}
            />
          </>
        ) : null}
        <Icon name={jobsOpen ? "down" : "up"} />
      </button>
    </span>
  );
}

/** 草稿预览的长度上限：够认出内容即可，不把整段草稿铺进状态条浮层。 */
const DRAFT_PREVIEW_CHARS = 40;

/**
 * 状态条的草稿入口：有未保存草稿时常驻显示「N 处草稿未保存」（列表行的小标记之外的
 * 全局信号），点击展开跨论文清单——论文 × 笔记块、草稿预览，支持逐项保存 / 放弃、
 * 按篇全部保存、一键全部保存，点论文标题直达该论文。草稿清空后入口自动收起。
 */
export function DraftsEntry() {
  const drafts = useField((s) => s.drafts);
  const [open, setOpen] = useState(false);
  const count = useMemo(
    () => Object.values(drafts).reduce((total, blocks) => total + Object.keys(blocks ?? {}).length, 0),
    [drafts],
  );
  // 清单开着时草稿被清空（保存 / 放弃完）自动收起。
  useEffect(() => {
    if (open && !count) setOpen(false);
  }, [open, count]);
  if (!count) return null;
  return (
    <span className={`ef-status-drafts${open ? " is-open" : ""}`}>
      <button
        id="drafts-toggle"
        type="button"
        aria-expanded={open}
        aria-controls={open ? "drafts-panel" : undefined}
        title="查看未保存的笔记草稿（可逐项保存、放弃或一键全部保存）"
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          <b>{count}</b> 处草稿未保存
        </span>
        <Icon name={open ? "down" : "up"} />
      </button>
      {open ? <DraftsPanel onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

/**
 * 跨论文的未保存草稿清单（状态条上拉浮层，与作业面板同族的非模态面板）：
 * 打开时逐篇取标题；论文已不存在（如删除后遗留）也能放弃清理。
 */
function DraftsPanel({ onClose }: { onClose: () => void }) {
  const drafts = useField((s) => s.drafts);
  const saveNote = useField((s) => s.saveNote);
  const setNoteDraft = useField((s) => s.setNoteDraft);
  const saveAllNoteDrafts = useField((s) => s.saveAllNoteDrafts);
  const saveAllDrafts = useField((s) => s.saveAllDrafts);
  const selectDomain = useField((s) => s.selectDomain);
  const selectPaper = useField((s) => s.selectPaper);
  const rootRef = useRef<HTMLDivElement>(null);
  const paperIds = useMemo(() => Object.keys(drafts), [drafts]);
  const [titles, setTitles] = useState<Record<string, { title: string; domainId: string } | null>>({});

  // 打开与论文集变化时取一次标题；取不到（论文已删）记 null，行内给「放弃」清理入口。
  useEffect(() => {
    let cancelled = false;
    void Promise.all(paperIds.map(async (id) => [id, await repo.getPaper(id)] as const))
      .then((entries) => {
        if (cancelled) return;
        setTitles(
          Object.fromEntries(
            entries.map(([id, paper]) => [
              id,
              paper ? { title: paper.titleZh || paper.title, domainId: paper.domainId } : null,
            ]),
          ),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [paperIds]);

  // Esc / 点在面板与入口之外收起；入口自身再点一次就是切换，不在这里重复处理。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (document.getElementById("drafts-toggle")?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDoc);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [onClose]);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const total = paperIds.reduce((sum, id) => sum + Object.keys(drafts[id] ?? {}).length, 0);

  async function jumpToPaper(paperId: string, domainId: string | null | undefined) {
    onClose();
    try {
      if (domainId) await selectDomain(domainId);
      await selectPaper(paperId);
    } catch {
      // selectDomain 失败已弹提示；直达不是关键路径，保持清单可用。
    }
  }

  return (
    <div
      ref={rootRef}
      id="drafts-panel"
      className="ef-drafts"
      role="dialog"
      aria-label="未保存草稿清单"
      tabIndex={-1}
    >
      <header className="ef-drafts-head">
        <h2>
          未保存草稿
          <span className="ef-drafts-count mono">{total}</span>
        </h2>
        <span className="ef-drafts-spacer" />
        <button type="button" className="ef-drafts-save-all" onClick={() => void saveAllDrafts()}>
          全部保存
        </button>
        <button type="button" className="ef-drafts-close" aria-label="收起草稿清单" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="ef-drafts-scroll">
        {paperIds.map((paperId) => {
          const meta = titles[paperId];
          const blocks = NOTE_DISPLAY_ORDER.filter((kind) => drafts[paperId]?.[kind] !== undefined);
          return (
            <section className="ef-drafts-group" key={paperId} aria-label={meta ? meta.title : "论文"}>
              <div className="ef-drafts-group-head">
                {meta ? (
                  <button
                    type="button"
                    className="ef-drafts-paper"
                    title="打开这篇论文"
                    onClick={() => void jumpToPaper(paperId, meta.domainId)}
                  >
                    {meta.title}
                  </button>
                ) : (
                  <span className="ef-drafts-paper is-missing">论文已不存在（草稿残留）</span>
                )}
                <span className="ef-drafts-block-count mono">{blocks.length} 块</span>
                {meta ? (
                  <button type="button" className="ef-drafts-group-save" onClick={() => void saveAllNoteDrafts(paperId)}>
                    保存本篇
                  </button>
                ) : null}
              </div>
              <ul className="ef-drafts-rows">
                {blocks.map((kind) => {
                  const value = drafts[paperId]?.[kind] ?? "";
                  const chars = [...value.replace(/\s+/g, " ").trim()];
                  const preview = chars.slice(0, DRAFT_PREVIEW_CHARS).join("");
                  return (
                    <li className="ef-drafts-row" key={kind}>
                      <span className="ef-drafts-kind">{NOTE_LABELS[kind].zh}</span>
                      <span className="ef-drafts-preview">
                        {preview || "（空白草稿）"}
                        {chars.length > DRAFT_PREVIEW_CHARS ? "…" : ""}
                      </span>
                      <span className="ef-drafts-row-actions">
                        {meta ? (
                          <button
                            type="button"
                            aria-label={`保存${NOTE_LABELS[kind].zh}草稿`}
                            title="保存这块草稿"
                            onClick={() => void saveNote(paperId, kind, value)}
                          >
                            保存
                          </button>
                        ) : null}
                        <button
                          type="button"
                          aria-label={`放弃${NOTE_LABELS[kind].zh}草稿`}
                          title="放弃这块草稿（不写库）"
                          onClick={() => setNoteDraft(paperId, kind, null)}
                        >
                          放弃
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
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
      <JobsToggle />
      <DraftsEntry />
      <span>{hasUsableProvider(settings) ? "AI 服务已配置" : "尚未配置 AI 服务"}</span>
      <span>{mineruLabel}</span>
      <span className="right">
        <span className="mono">{shortcut("K")}</span> 搜索
      </span>
    </footer>
  );
}
