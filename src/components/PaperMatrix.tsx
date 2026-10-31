import type { CSSProperties, ReactNode } from "react";
import { MINERU_STATUS_LABELS, READING_STATUS_LABELS, type FieldSource, type PaperListItem } from "../lib/types";
import { pad2 } from "../lib/util";
import { hasDraft as paperHasDraft, useField } from "../store";
import { Icon } from "./ui";

/** 批量模式与「全选」共用的复选方块：行首替代序号出现，视觉与状态徽标同源。 */
export function CheckSquare({ on }: { on: boolean }) {
  return (
    <span className={`ef-row-check ${on ? "is-on" : ""}`.trim()} aria-hidden="true">
      {on ? <Icon name="check" /> : null}
    </span>
  );
}

/**
 * 「标题待确认」徽标：标题来源仍是文件名（fieldSources.title === "file"）的论文，
 * 提示这个标题是占位、可校对。点击打开编辑论文信息（定位标题输入）。
 */
export function TitlePendingBadge({ onEdit }: { onEdit: () => void }) {
  return (
    <button
      type="button"
      className="ef-title-pending"
      title="这个标题来自文件名，是占位值。点击打开论文信息修改，或到文献库重查著录。"
      onClick={(event) => {
        event.stopPropagation();
        onEdit();
      }}
    >
      标题待确认
    </button>
  );
}

/** 论文的标题来源是否仍是文件名（AI 补全与文献库都没有替换过）。 */
export function titleStillFromFile(sources: Partial<Record<string, FieldSource>> | undefined): boolean {
  return sources?.title === "file";
}

export function PaperRow({
  paper,
  index,
  selected,
  onSelect,
  batch = false,
  checked = false,
  onToggleCheck,
  extra,
}: {
  paper: PaperListItem;
  index: number;
  selected: boolean;
  onSelect: () => void;
  /** 批量选择模式：点击行改为勾选/取消，选中态让位给勾选态。 */
  batch?: boolean;
  checked?: boolean;
  onToggleCheck?: () => void;
  /** 行下方附着的次级操作区（如归档行的领域徽标与直达入口）；批量模式不渲染。 */
  extra?: ReactNode;
  compact?: boolean;
}) {
  const title = paper.titleZh || paper.title;
  const english = paper.titleZh ? paper.title : "";
  const hasDraft = useField((s) => paperHasDraft(s, paper.id));
  const openDialog = useField((s) => s.openDialog);
  const className = [
    "ef-row",
    "pf-stagger",
    !batch && selected ? "is-selected" : "",
    batch && checked ? "is-checked" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const row = (
    <button
      type="button"
      className={className}
      /* --pf-i drives .pf-stagger's per-row delay; capped at 12 inside the
         utility so a full-column remount stays ≤ ~450ms total. */
      style={{ "--pf-i": index } as CSSProperties}
      onClick={batch ? onToggleCheck : onSelect}
      role={batch ? "checkbox" : undefined}
      aria-checked={batch ? checked : undefined}
      aria-current={!batch && selected ? "true" : undefined}
    >
      <div className="ef-row-top">
        {batch ? <CheckSquare on={checked} /> : <span className="ef-row-index mono">{pad2(index + 1)}</span>}
        <span className={`ef-row-status is-${paper.readingStatus}`}>
          {paper.readingStatus === "read" ? <Icon name="check" /> : null}
          {READING_STATUS_LABELS[paper.readingStatus]}
        </span>
      </div>
      <h3>
        {title}
        {titleStillFromFile(paper.fieldSources) ? (
          <TitlePendingBadge onEdit={() => openDialog("edit-paper", paper.id)} />
        ) : null}
      </h3>
      {english ? <p className="ef-row-en">{english}</p> : null}
      <div className="ef-row-meta">
        <span>{[paper.venue, paper.year].filter(Boolean).join(" · ") || "会议 / 期刊待补充"}</span>
        <span>{paper.firstAuthor || "作者待补充"}</span>
        {paper.mineruStatus && paper.mineruStatus !== "done" ? (
          <span>{MINERU_STATUS_LABELS[paper.mineruStatus]}</span>
        ) : null}
        {paper.notesFilled != null && paper.notesFilled < 5 ? (
          <span className="ef-row-notes-count">笔记 {paper.notesFilled}/5</span>
        ) : null}
        {hasDraft ? <span className="ef-row-draft">笔记草稿未保存</span> : null}
      </div>
    </button>
  );
  if (!extra || batch) return row;
  return (
    <div className="ef-row-shell">
      {row}
      {extra}
    </div>
  );
}

export function PaperMatrix({
  papers,
  selectedId,
  onSelect,
  batch = false,
  checkedIds = [],
  onToggleCheck,
  rowExtra,
}: {
  papers: PaperListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  batch?: boolean;
  checkedIds?: string[];
  onToggleCheck?: (id: string) => void;
  /** 每行的次级操作区（归档模式用）；批量模式自动忽略。 */
  rowExtra?: (paper: PaperListItem) => ReactNode;
  compact?: boolean;
}) {
  return (
    <div className="ef-paper-list" role="listbox" aria-label="论文列表">
      {papers.map((paper, index) => (
        <PaperRow
          key={paper.id}
          paper={paper}
          index={index}
          selected={paper.id === selectedId}
          onSelect={() => onSelect(paper.id)}
          batch={batch}
          checked={checkedIds.includes(paper.id)}
          onToggleCheck={() => onToggleCheck?.(paper.id)}
          extra={rowExtra?.(paper)}
        />
      ))}
    </div>
  );
}
