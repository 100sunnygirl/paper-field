import type { CSSProperties } from "react";
import { MINERU_STATUS_LABELS, READING_STATUS_LABELS, type PaperListItem } from "../lib/types";
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

export function PaperRow({
  paper,
  index,
  selected,
  onSelect,
  batch = false,
  checked = false,
  onToggleCheck,
}: {
  paper: PaperListItem;
  index: number;
  selected: boolean;
  onSelect: () => void;
  /** 批量选择模式：点击行改为勾选/取消，选中态让位给勾选态。 */
  batch?: boolean;
  checked?: boolean;
  onToggleCheck?: () => void;
  compact?: boolean;
}) {
  const title = paper.titleZh || paper.title;
  const english = paper.titleZh ? paper.title : "";
  const hasDraft = useField((s) => paperHasDraft(s, paper.id));
  const className = [
    "ef-row",
    "pf-stagger",
    !batch && selected ? "is-selected" : "",
    batch && checked ? "is-checked" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
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
      <h3>{title}</h3>
      {english ? <p className="ef-row-en">{english}</p> : null}
      <div className="ef-row-meta">
        <span>{[paper.venue, paper.year].filter(Boolean).join(" · ") || "会议 / 期刊待补充"}</span>
        <span>{paper.firstAuthor || "作者待补充"}</span>
        {paper.mineruStatus && paper.mineruStatus !== "done" ? (
          <span>{MINERU_STATUS_LABELS[paper.mineruStatus]}</span>
        ) : null}
        {hasDraft ? <span className="ef-row-draft">笔记草稿未保存</span> : null}
      </div>
    </button>
  );
}

export function PaperMatrix({
  papers,
  selectedId,
  onSelect,
  batch = false,
  checkedIds = [],
  onToggleCheck,
}: {
  papers: PaperListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  batch?: boolean;
  checkedIds?: string[];
  onToggleCheck?: (id: string) => void;
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
        />
      ))}
    </div>
  );
}
