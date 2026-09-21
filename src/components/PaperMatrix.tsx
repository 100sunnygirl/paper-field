import type { PaperListItem } from "../lib/types";
import { OpenChip } from "./ui";

export function PaperRow({
  paper,
  index,
  selected,
  onSelect,
  compact = false,
}: {
  paper: PaperListItem;
  index: number;
  selected: boolean;
  onSelect: () => void;
  compact?: boolean;
}) {
  const title = paper.titleZh || paper.title;
  return (
    <button
      type="button"
      className={`ef-row ${compact ? "is-compact" : ""} ${selected ? "is-selected" : ""}`}
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
    >
      <span className={`ef-wedge ${paper.readingStatus}`} aria-hidden="true" />
      <div>
        <h3>
          {String(index + 1).padStart(2, "0")} / {title}
        </h3>
        <p>{[paper.venue, paper.year].filter(Boolean).join(" · ") || "UNPLACED"}</p>
      </div>
      <OpenChip value={paper.codeOpenSource} />
      {compact ? null : (
        <span className="ef-author">
          {paper.firstAuthor ? `${paper.firstAuthor}${paper.authorCount > 1 ? " et al." : ""}` : "—"}
        </span>
      )}
    </button>
  );
}

export function PaperMatrix({
  papers,
  selectedId,
  onSelect,
  compact = false,
}: {
  papers: PaperListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  compact?: boolean;
}) {
  return (
    <div className={`ef-matrix ${compact ? "is-compact" : ""}`} role="listbox" aria-label="Paper navigator">
      {papers.map((paper, index) => (
        <PaperRow
          key={paper.id}
          paper={paper}
          index={index}
          selected={paper.id === selectedId}
          onSelect={() => onSelect(paper.id)}
          compact={compact}
        />
      ))}
    </div>
  );
}
