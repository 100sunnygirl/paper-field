import { READING_STATUS_LABELS, type PaperListItem } from "../lib/types";
import { pad2 } from "../lib/util";
import { Icon } from "./ui";

export function PaperRow({
  paper,
  index,
  selected,
  onSelect,
}: {
  paper: PaperListItem;
  index: number;
  selected: boolean;
  onSelect: () => void;
  compact?: boolean;
}) {
  const title = paper.titleZh || paper.title;
  const english = paper.titleZh ? paper.title : "";
  return (
    <button
      type="button"
      className={`ef-row ${selected ? "is-selected" : ""}`}
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
    >
      <div className="ef-row-top">
        <span className="mono">
          {pad2(index + 1)} / PAPER
        </span>
        <span className="ef-row-status">
          {paper.readingStatus === "read" ? <Icon name="check" /> : null}
          {READING_STATUS_LABELS[paper.readingStatus]}
        </span>
      </div>
      <h3>{title}</h3>
      {english ? <p className="ef-row-en">{english}</p> : null}
      <div className="ef-row-meta">
        <span>{[paper.venue, paper.year].filter(Boolean).join(" · ") || "待补全会议信息"}</span>
        <span>{paper.firstAuthor || "作者待补充"}</span>
      </div>
    </button>
  );
}

export function PaperMatrix({
  papers,
  selectedId,
  onSelect,
}: {
  papers: PaperListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
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
        />
      ))}
    </div>
  );
}
