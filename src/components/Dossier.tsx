import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { bindingLabel, currentKeymap, eventMatchesBinding } from "../lib/keymap";
import {
  FONT_STEPS,
  FONT_STEP_LABELS,
  WIDTH_SCALES,
  WIDTH_STEP_LABELS,
  clearPaperAppearance,
  getAppearance,
  hasPaperAppearance,
  loadAppearanceStore,
  setDefaultAppearance,
  setPaperAppearance,
  type AppearanceStore,
  type ReadWidthStep,
  type ReadingAppearance,
} from "../lib/readingAppearance";
import {
  setContextFolded,
  subscribeContextFold,
  getContextFold,
  type ContextBlockId,
} from "../lib/contextFold";
import {
  appendExcerpt,
  assignFulltextAnchors,
  buildExcerptMarkdown,
  buildSectionCitation,
  extractFulltextHeadings,
  headingForSelection,
  highlightFulltextMatches,
  insertQuoteAtCursor,
  selectionInRoot,
  type FulltextSelection,
} from "../lib/fulltext";
import { onMarkdownClick, renderMarkdown } from "../lib/markdown";
import { providerLabel } from "../lib/mineruPlan";
import { clearReparseSnapshot, fulltextStats, getReparseRecord } from "../lib/reparse";
import { repo } from "../lib/repo";
import { isNoteHintDismissed, NOTE_HINT_QUESTIONS, setNoteHintDismissed } from "../lib/noteHints";
import { loadNoteLayout, moveNoteKind as moveNoteKindInOrder, saveNoteLayout, type NoteLayout } from "../lib/noteLayout";
import { loadReadingSpots, saveReadingSpot } from "../lib/readingSpot";
import { daysInto, readingSinceFor } from "../lib/readingSince";
import { openLocalPdf } from "../lib/mineru";
import {
  JOB_STATUS_LABELS,
  JOB_TYPE_LABELS,
  MINERU_STATUS_LABELS,
  NOTE_DISPLAY_ORDER,
  NOTE_LABELS,
  READING_STATUS_LABELS,
  noteSourceLabel,
  type NoteKind,
  type OpenSource,
  type PaperDetail,
  type ReadingStatus,
} from "../lib/types";
import { hasUsableProvider } from "../lib/settings";
import { arxivAbsUrl, arxivPdfUrl, doiUrl, openExternal, safeHttpUrl } from "../lib/urls";
import { formatDate, modLabel, pad2 } from "../lib/util";
import { useField } from "../store";
import { Button, Dialog, Empty, ExternalResource, Icon, SourceBadge, type IconName } from "./ui";

/** 本页目录里解析全文章节二级项的显示上限：更长的全文只列前若干节并注明其余节数。 */
const TOC_SECTION_LIMIT = 30;

/** 把区段锚点 id 转成浮标 / 提示里可读的中文标签。 */
function spotSectionLabel(section: string, headings: ReturnType<typeof extractFulltextHeadings>): string {
  if (section === "abstract") return "摘要";
  if (section === "fulltext") return "解析全文";
  if (section.startsWith("note-")) {
    const kind = section.slice(5) as NoteKind;
    return NOTE_LABELS[kind]?.zh ?? section;
  }
  if (section.startsWith("ft-sec-")) {
    const heading = headings.find((item) => item.id === section);
    return heading ? `§${heading.number} ${heading.text}` : "解析全文";
  }
  return section;
}

/**
 * 「在读第 N 天」的文案：优先本机记录的在读起点；没有记录（功能上线前就在读、
 * 或换机器）诚实回落入库时间——措辞用「入库第 N 天」，不冒充在读时长。
 */
function readingDayLine(paperId: string, createdAt: string): string {
  const since = readingSinceFor(paperId);
  const days = daysInto(since);
  if (since && days) return `在读第 ${days} 天`;
  const fromCreated = daysInto(createdAt);
  return fromCreated ? `入库第 ${fromCreated} 天` : "阅读状态由你手动标记";
}

function NoteEditor({
  kind,
  index,
  paper,
  onStart,
  onSavedNext,
  fulltextPick,
  collapsed,
  onToggleCollapsed,
  onMove,
  canMoveUp,
  canMoveDown,
}: {
  kind: NoteKind;
  index: number;
  paper: PaperDetail;
  onStart: () => void;
  /** ⌘Enter 保存成功后跳到下一块空笔记继续写。 */
  onSavedNext: () => void;
  /** 解析全文里最近一次选中的片段：供「引用解析全文」插入光标处。 */
  fulltextPick: FulltextSelection | null;
  /** 本机记住的折叠偏好；编辑中不可折叠（折叠开关隐藏）。 */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** 上移 / 下移这块笔记的显示顺序（本机记住）。 */
  onMove: (direction: "up" | "down") => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const saveNote = useField((s) => s.saveNote);
  const setNoteDraft = useField((s) => s.setNoteDraft);
  const setFlash = useField((s) => s.setFlash);
  // 草稿存在 store 里（按论文、按块）：切换论文、搜索、后台刷新都不会丢，切回来编辑框还在。
  const draft = useField((s) => s.drafts[paper.id]?.[kind]);
  const hasDraft = draft !== undefined;
  // Esc 只收起编辑器：草稿原样保留（本地 + store），再点「继续编辑」可接着写。
  const [dismissed, setDismissed] = useState(false);
  const editing = hasDraft && !dismissed;
  const block = paper.notes[kind];
  const value = editing ? draft : block.content;
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 空块的研究问题提示：可关闭（本机记住，按块独立）。
  const [hintDismissed, setHintDismissed] = useState(() => isNoteHintDismissed(kind));

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
    else setFailed(false);
  }, [editing]);

  useEffect(() => {
    // 草稿落库（保存 / 放弃）后收起状态复位，下次进入编辑从干净状态开始。
    if (!hasDraft) setDismissed(false);
  }, [hasDraft]);

  const label = NOTE_LABELS[kind];
  const saveHint = `${bindingLabel(currentKeymap().saveNote)} 保存 · ${modLabel()}+Enter 写下一块 · 失焦自动保存 · Esc 收起`;

  async function commit(): Promise<boolean> {
    if (saving) return false;
    setSaving(true);
    setFailed(false);
    try {
      await saveNote(paper.id, kind, value);
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setSaving(false);
    }
  }

  /**
   * 失焦自动落库（快捷键保存的兜底而非替代）：点出块外 / 切换块时自动保存；
   * 一个字没改的草稿安静收起（不写库、不弹提示）；失败则草稿保留可重试。
   * 编辑框内自己的按钮（放弃修改 / 引用解析全文 / 保存笔记）先按住焦点再动作，
   * 不触发这次自动保存。
   */
  async function autosaveOnBlur() {
    if (saving || draft === undefined) return;
    if (draft === block.content) {
      setNoteDraft(paper.id, kind, null);
      return;
    }
    try {
      await saveNote(paper.id, kind, draft);
    } catch {
      // saveNote 已弹失败提示；草稿保留，编辑框仍在，行内给出可重试状态。
      setFailed(true);
    }
  }

  function cancel() {
    setFailed(false);
    setNoteDraft(paper.id, kind, null);
  }

  /** 把解析全文里当前选中的段落作为引用插入光标处（无选中时给出指引）。 */
  function quoteFromFulltext() {
    if (!fulltextPick) {
      setFlash({ tone: "warn", text: "先在解析全文中选中要引用的段落，再点「引用解析全文」。" });
      return;
    }
    const quote = buildExcerptMarkdown(fulltextPick.text, fulltextPick.heading);
    const position = textareaRef.current?.selectionStart ?? value.length;
    setNoteDraft(paper.id, kind, insertQuoteAtCursor(value, position, quote));
    setFlash({
      tone: "ok",
      text: fulltextPick.heading
        ? `已插入引用（§${fulltextPick.heading.number} ${fulltextPick.heading.text}），锚点可跳回原文。`
        : "已插入原文引用。",
    });
  }

  function onEditorKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      // 首次 Esc 只收起编辑器：草稿留在 store 与本地，不丢弃。
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
      setFlash({ tone: "ok", text: `已收起${label.zh}编辑器，草稿已保留。` });
      return;
    }
    if (eventMatchesBinding(event.nativeEvent, currentKeymap().saveNote)) {
      event.preventDefault();
      event.stopPropagation();
      void commit();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void commit().then((ok) => {
        if (ok) onSavedNext();
      });
    }
  }

  return (
    <section
      className={["ef-note", editing ? "is-editing" : "", value.trim() ? "" : "is-empty"].filter(Boolean).join(" ")}
      id={`note-${kind}`}
    >
      <div className="ef-note-head">
        {editing ? null : (
          <button
            type="button"
            className="ef-note-fold"
            aria-expanded={!collapsed}
            aria-label={collapsed ? `展开${label.zh}` : `折叠${label.zh}`}
            title={collapsed ? `展开${label.zh}` : `折叠${label.zh}`}
            onClick={onToggleCollapsed}
          >
            <Icon name="down" />
          </button>
        )}
        <span className="ef-note-number" aria-hidden="true">
          {pad2(index + 1)}
        </span>
        <h3>{label.zh}</h3>
        {/* Esc 收起后草稿仍在：块头常驻一枚提示，避免忘掉没写完的内容。 */}
        {hasDraft && !editing ? <span className="ef-note-draft-chip">草稿保留中</span> : null}
        {/* 来源标签只对写了内容的块有意义；空块不标「手动笔记」。 */}
        {value.trim() ? <span className={`ef-note-source is-${block.source}`}>{noteSourceLabel(block)}</span> : null}
        {editing ? null : hasDraft ? (
          <button
            type="button"
            className="ef-note-edit"
            aria-label={`继续编辑${label.zh}`}
            onClick={() => {
              setDismissed(false);
              onStart();
            }}
          >
            <Icon name="edit" />
            继续编辑
          </button>
        ) : value.trim() ? (
          <button type="button" className="ef-note-edit" onClick={onStart} aria-label={`编辑${label.zh}`}>
            <Icon name="edit" />
            编辑
          </button>
        ) : null}
        <span className="ef-note-move">
          <button
            type="button"
            aria-label={`上移${label.zh}`}
            title={`上移${label.zh}`}
            disabled={!canMoveUp}
            onClick={() => onMove("up")}
          >
            <Icon name="up" />
          </button>
          <button
            type="button"
            aria-label={`下移${label.zh}`}
            title={`下移${label.zh}`}
            disabled={!canMoveDown}
            onClick={() => onMove("down")}
          >
            <Icon name="down" />
          </button>
        </span>
      </div>
      {editing ? (
        <>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setNoteDraft(paper.id, kind, e.target.value)}
            onKeyDown={onEditorKeyDown}
            onBlur={() => void autosaveOnBlur()}
            aria-label={`${label.zh}内容`}
          />
          <div className="ef-edit-actions">
            <span className="ef-edit-hint">
              {saving
                ? "保存中…"
                : failed
                  ? "保存失败，输入已保留，可重试。"
                  : `编辑中 · 尚未保存 · ${saveHint}`}
            </span>
            {/* 按住焦点再动作（onMouseDown preventDefault）：这三个按钮不触发失焦自动保存，
                「放弃修改」才能真正丢掉未保存的内容，插入引用也不会被自动保存清掉。 */}
            <Button
              type="button"
              size="sm"
              title="放弃这次未保存的修改，恢复原内容"
              onMouseDown={(e) => e.preventDefault()}
              onClick={cancel}
              disabled={saving}
            >
              放弃修改
            </Button>
            {paper.parsedMarkdown.trim() ? (
              <Button type="button" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={quoteFromFulltext} disabled={saving}>
                引用解析全文
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="primary"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void commit()}
              disabled={saving}
            >
              {saving ? "保存中…" : "保存笔记"}
            </Button>
          </div>
        </>
      ) : collapsed ? (
        // 折叠态只留块头：一行字数提示，点折叠开关展开。
        <p className="ef-note-collapsed-hint">
          {value.trim() ? `${[...value.trim()].length} 字 · 已折叠` : "未写 · 已折叠"}
        </p>
      ) : value.trim() ? (
        <div className="ef-note-text ef-md" onClick={onMarkdownClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }} />
      ) : (
        // 空块本身就是入口：点这里就地开写，不必去工具条或右上角找按钮。
        // 上方一行可关闭的研究问题，给「不知从哪下笔」一个切入点。
        <div className="ef-note-empty">
          {!hintDismissed && !hasDraft ? (
            <p className="ef-note-question">
              <span>{NOTE_HINT_QUESTIONS[kind]}</span>
              <button
                type="button"
                aria-label={`收起${label.zh}的提示问题`}
                title="收起这条提示（之后不再显示）"
                onClick={() => {
                  setHintDismissed(true);
                  setNoteHintDismissed(kind, true);
                }}
              >
                <Icon name="close" />
              </button>
            </p>
          ) : null}
          <button type="button" className="ef-note-start" onClick={onStart}>
            <Icon name="plus" />
            写{label.zh}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * 重新解析的两版对照：新结果完成后在解析全文顶部展示新旧统计对照，由用户决定
 * 采用哪一版（快照存本机，见 lib/reparse）。解析进行中先说明「当前仍是上一版」。
 */
function ReparseCompareNote({ paper }: { paper: PaperDetail }) {
  const setFlash = useField((s) => s.setFlash);
  const refresh = useField((s) => s.refresh);
  const [record, setRecord] = useState(() => getReparseRecord(paper.id));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRecord(getReparseRecord(paper.id));
  }, [paper.id, paper.parsedMarkdown]);

  if (!record) return null;
  const prevStats = fulltextStats(record.prev.markdown);

  function adoptNew() {
    clearReparseSnapshot(paper.id);
    setRecord(null);
  }

  async function restoreOld() {
    if (busy) return;
    setBusy(true);
    try {
      await repo.saveParsedMarkdown(paper.id, record!.prev.markdown);
      clearReparseSnapshot(paper.id);
      setRecord(null);
      await refresh();
      setFlash({ tone: "ok", text: "已恢复上一版解析全文。" });
    } catch (err) {
      setFlash({
        tone: "error",
        text: `恢复旧版失败：${err instanceof Error ? err.message : String(err)}，新版保持不变。`,
      });
    } finally {
      setBusy(false);
    }
  }

  if (!record.next) {
    // 重解析还在进行：旧版全文就是当前显示的内容，先给一句确定性。
    return (
      <p className="ef-reparse-note" role="note">
        正在重新解析：这里显示的仍是上一版全文，新结果完成后可在两版之间选择。
      </p>
    );
  }
  return (
    <div className="ef-reparse-note is-compare" role="note" aria-label="新旧版本对照">
      <p>
        <b>重新解析完成，新旧版本对照</b>
        <br />
        旧版（{providerLabel(record.prev.provider)}）约 {prevStats.chars.toLocaleString("zh-Hans-CN")} 字 ·{" "}
        {prevStats.sections} 节 → 新版（{providerLabel(record.next.provider)}）约{" "}
        {record.next.chars.toLocaleString("zh-Hans-CN")} 字 · {record.next.sections} 节
        {prevStats.chars === record.next.chars && prevStats.sections === record.next.sections ? " · 两版统计一致" : ""}
      </p>
      <p className="ef-reparse-actions">
        <Button type="button" size="sm" disabled={busy} onClick={() => void restoreOld()}>
          恢复旧版
        </Button>
        <Button type="button" size="sm" variant="primary" onClick={adoptNew}>
          采用新版（当前显示）
        </Button>
      </p>
    </div>
  );
}

/**
 * 解析全文的渲染容器：渲染后按小节补锚点（消毒层剥掉了外部 id），
 * 选中文字后浮出「摘到笔记」条，一键把引用写入对应笔记块并保留跳回锚点。
 */
function FulltextDoc({
  paper,
  onPick,
}: {
  paper: PaperDetail;
  /** 选中变化时上报（笔记编辑器的「引用解析全文」用最后一次选中）；选区收起不上报，保留最近一次。 */
  onPick: (pick: FulltextSelection) => void;
}) {
  const setNoteDraft = useField((s) => s.setNoteDraft);
  const setFlash = useField((s) => s.setFlash);
  const rootRef = useRef<HTMLDivElement>(null);
  const headings = useMemo(() => extractFulltextHeadings(paper.parsedMarkdown), [paper.parsedMarkdown]);
  const [bar, setBar] = useState<{ pick: FulltextSelection; top: number; left: number } | null>(null);
  // 全文内检索：输入即高亮 + 命中计数 + 上一处/下一处跳转。
  const [searchQuery, setSearchQuery] = useState("");
  const [hitIndex, setHitIndex] = useState(-1);
  const [hitCount, setHitCount] = useState(0);
  const scrollNextHit = useRef(false);

  // innerHTML 每次更新后重新挂锚点；无依赖（幂等），渲染多少次都安全。
  useEffect(() => {
    assignFulltextAnchors(rootRef.current, headings);
  });

  // 输入或跳转后重新高亮；导航（上一处/下一处）时才滚动到当前命中。
  useEffect(() => {
    const scroll = scrollNextHit.current;
    scrollNextHit.current = false;
    const count = highlightFulltextMatches(rootRef.current, searchQuery, hitIndex, { scroll });
    setHitCount(count);
    if (hitIndex >= count) setHitIndex(count ? count - 1 : -1);
  }, [searchQuery, hitIndex, paper.parsedMarkdown]);

  function searchNext(direction: 1 | -1) {
    if (!hitCount) return;
    scrollNextHit.current = true;
    setHitIndex((index) => (index + direction + hitCount) % hitCount);
  }

  useEffect(() => {
    const report = () => {
      const found = selectionInRoot(rootRef.current);
      if (!found) {
        setBar(null);
        return;
      }
      const heading = headingForSelection(rootRef.current!, headings, found.node);
      const pick: FulltextSelection = { text: found.text, heading };
      onPick(pick);
      const selection = document.getSelection();
      const rect = selection && selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
      setBar({ pick, top: rect?.top ?? 0, left: (rect?.left ?? 0) + (rect?.width ?? 0) / 2 });
    };
    // 容器滚动后浮条会漂离选中位置：跟随收起（选区本身不受影响）。
    const hide = () => setBar(null);
    // 单栏时滚的是 .ef-read-scroll；并读时滚的是面板正文，两处都听。
    const scrollers = [
      rootRef.current?.closest(".ef-read-scroll"),
      rootRef.current?.closest(".ef-fulltext-panel-body"),
    ].filter((node): node is Element => Boolean(node));
    document.addEventListener("selectionchange", report);
    scrollers.forEach((node) => node.addEventListener("scroll", hide, { passive: true }));
    return () => {
      document.removeEventListener("selectionchange", report);
      scrollers.forEach((node) => node.removeEventListener("scroll", hide));
    };
  }, [headings, onPick]);

  function excerptTo(kind: NoteKind) {
    if (!bar) return;
    // 追加而非覆盖：块里已有的内容保留，引用另起一段。
    const base = useField.getState().drafts[paper.id]?.[kind] ?? paper.notes[kind].content;
    setNoteDraft(paper.id, kind, appendExcerpt(base, buildExcerptMarkdown(bar.pick.text, bar.pick.heading)));
    setFlash({
      tone: "ok",
      text: bar.pick.heading
        ? `已摘录到「${NOTE_LABELS[kind].zh}」（§${bar.pick.heading.number}），引用锚点可跳回原文。`
        : `已摘录到「${NOTE_LABELS[kind].zh}」。`,
    });
    setBar(null);
  }

  async function copyCitation() {
    if (!bar) return;
    const title = paper.titleZh || paper.title;
    const quote = bar.pick.text.replace(/\s+/g, " ").trim();
    const text = bar.pick.heading
      ? `${buildSectionCitation(title, bar.pick.heading)}：${quote}`
      : `《${title}》：${quote}`;
    try {
      await navigator.clipboard.writeText(text);
      setFlash({ tone: "ok", text: "已复制「论文+小节」引用。" });
    } catch {
      // 非安全上下文 / 无剪贴板权限时降级提示（与作业面板复制失败同口径）。
      setFlash({ tone: "warn", text: "复制失败：当前环境无法访问剪贴板。" });
    }
    setBar(null);
  }

  return (
    <>
      <ReparseCompareNote paper={paper} />
      <div className="ef-ft-search" role="search">
        <Icon name="search" />
        <input
          type="search"
          value={searchQuery}
          placeholder="检索全文…"
          aria-label="检索解析全文"
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setHitIndex(e.target.value.trim() ? 0 : -1);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              searchNext(1);
            }
          }}
        />
        {searchQuery.trim() ? (
          <>
            <span className="ef-ft-search-count mono" aria-live="polite">
              {hitCount ? `第 ${hitIndex < 0 ? 0 : hitIndex + 1} / ${hitCount} 处` : "0 处"}
            </span>
            <button
              type="button"
              aria-label="上一处命中"
              title="上一处命中"
              disabled={!hitCount}
              onClick={() => searchNext(-1)}
            >
              <Icon name="up" />
            </button>
            <button
              type="button"
              aria-label="下一处命中"
              title="下一处命中"
              disabled={!hitCount}
              onClick={() => searchNext(1)}
            >
              <Icon name="down" />
            </button>
          </>
        ) : null}
      </div>
      <div
        ref={rootRef}
        className="ef-note-text ef-md"
        onClick={onMarkdownClick}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(paper.parsedMarkdown) }}
      />
      {bar ? (
        <div
          className="ef-excerpt-bar"
          role="toolbar"
          aria-label="摘录到笔记"
          style={{ top: bar.top, left: bar.left }}
        >
          {NOTE_DISPLAY_ORDER.map((kind) => (
            <button key={kind} type="button" onClick={() => excerptTo(kind)}>
              摘到{NOTE_LABELS[kind].zh}
            </button>
          ))}
          <button type="button" className="ef-excerpt-copy" onClick={() => void copyCitation()}>
            复制引用
          </button>
        </div>
      ) : null}
    </>
  );
}

/**
 * 资料栏的可折叠区块：右栏与窄屏抽屉可能同时挂两份实例，折叠状态走外部
 * store（contextFold，localStorage 记忆本机偏好）保证两处同步。
 */
function ContextBlock({
  id,
  title,
  icon,
  className = "",
  children,
}: {
  id: ContextBlockId;
  title: string;
  icon?: IconName;
  className?: string;
  children: ReactNode;
}) {
  const folded = useSyncExternalStore(subscribeContextFold, getContextFold).folded[id] ?? false;
  return (
    <section className={`ef-context-block${folded ? " is-folded" : ""}${className ? ` ${className}` : ""}`.trim()}>
      <div className="ef-context-block-head">
        <h2 className="ef-context-title">
          {icon ? <Icon name={icon} /> : null}
          {title}
        </h2>
        <button
          type="button"
          className="ef-context-fold"
          aria-expanded={!folded}
          aria-label={folded ? `展开${title}` : `折叠${title}`}
          title={folded ? `展开${title}` : `折叠${title}`}
          onClick={() => setContextFolded(id, !folded)}
        >
          <Icon name="down" />
        </button>
      </div>
      {folded ? null : children}
    </section>
  );
}

function ContextPanel({
  paper,
  activeSection,
  onJump,
  noteOrder,
  appearance,
  appearanceOverride,
  onChangeAppearance,
  onResetAppearance,
  onApplyAppearanceDefault,
}: {
  paper: PaperDetail;
  activeSection: string;
  onJump: (id: string) => void;
  /** 笔记块的自定义显示顺序（本页目录与正文保持一致）。 */
  noteOrder: NoteKind[];
  /** 本篇生效的阅读外观（字号/行宽档位）。 */
  appearance: ReadingAppearance;
  /** 本篇是否有覆盖档位（「恢复默认」的可见依据）。 */
  appearanceOverride: boolean;
  onChangeAppearance: (next: ReadingAppearance) => void;
  onResetAppearance: () => void;
  onApplyAppearanceDefault: () => void;
}) {
  const settings = useField((s) => s.settings);
  const jobs = useField((s) => s.jobs);
  const setReadingStatus = useField((s) => s.setReadingStatus);
  const runPrepareMeta = useField((s) => s.runPrepareMeta);
  const runRefreshLinks = useField((s) => s.runRefreshLinks);
  const runDraftNotes = useField((s) => s.runDraftNotes);
  const retryMineru = useField((s) => s.retryMineru);
  const mineru = useField((s) => s.mineru);
  const effectiveProvider = useField((s) => s.effectiveProvider);
  const openSystemCard = useField((s) => s.openSystemCard);
  const cancelJob = useField((s) => s.cancelJob);
  const savePaperPatch = useField((s) => s.savePaperPatch);
  const setMode = useField((s) => s.setMode);
  const lookupHint = useField((s) => s.lookupHint);
  const openDialog = useField((s) => s.openDialog);
  const setFlash = useField((s) => s.setFlash);
  const markRead = useField((s) => s.markRead);
  const setJobsOpen = useField((s) => s.setJobsOpen);
  const active = jobs.filter(
    (job) => job.paperId === paper.id && (job.status === "running" || job.status === "queued"),
  );
  // 解析全文的小节标题 → 本页目录的二级导航；过长时截断显示并注明其余节数。
  const fulltextHeadings = useMemo(() => extractFulltextHeadings(paper.parsedMarkdown), [paper.parsedMarkdown]);
  const visibleHeadings = fulltextHeadings.slice(0, TOC_SECTION_LIMIT);

  // ---- 本篇状态卡：解析 / 著录 / 笔记三条进度 + 推荐的下一步 ----
  const parseDone = paper.parsedMarkdown.trim().length > 0;
  const parseRunning =
    paper.mineruStatus === "queued" || paper.mineruStatus === "submitted" || paper.mineruStatus === "parsing";
  const parseFailed = paper.mineruStatus === "error" || paper.mineruStatus === "cancelled";
  const metaFlags = [
    Boolean(paper.abstract.trim()),
    paper.year != null,
    Boolean(paper.venue),
    Boolean(paper.doi || paper.arxivId),
    paper.authors.length > 0,
  ];
  const metaDone = metaFlags.filter(Boolean).length;
  const notesWritten = NOTE_DISPLAY_ORDER.filter((kind) => paper.notes[kind].content.trim()).length;
  const parseLabel = parseDone
    ? "已完成"
    : parseFailed
      ? "解析失败"
      : parseRunning
        ? "解析中"
        : paper.pdfPath
          ? mineru.configured
            ? "待解析"
            : "未配置解析源"
          : paper.pdfUrl
            ? "在线 PDF"
            : "未关联 PDF";
  const nextEmptyKind = noteOrder.find((kind) => !paper.notes[kind].content.trim());
  let nextAction: { label: string; run: () => void } | null;
  let nextHint: string;
  if (!paper.pdfPath && !paper.pdfUrl) {
    nextAction = { label: "关联 PDF", run: () => openDialog("edit-paper", paper.id) };
    nextHint = "先给这篇论文关联 PDF，才能解析全文。";
  } else if (parseFailed) {
    nextAction = { label: "重新解析", run: () => void retryMineru(paper.id) };
    nextHint = "上一次解析没有成功，可重试。";
  } else if (parseRunning) {
    nextAction = { label: "查看作业进度", run: () => setJobsOpen(true) };
    nextHint = "正在解析，稍候即可阅读全文。";
  } else if (!parseDone && paper.pdfPath && !mineru.configured) {
    nextAction = { label: "配置解析源", run: () => void setMode("system") };
    nextHint = "配置 MinerU 解析源后可解析全文。";
  } else if (!parseDone && paper.pdfPath) {
    nextAction = { label: "发送到 MinerU 解析", run: () => void retryMineru(paper.id) };
    nextHint = "解析出全文后，摘录与引用都更方便。";
  } else if (metaDone < metaFlags.length) {
    nextAction = hasUsableProvider(settings)
      ? {
          label: "补全论文信息",
          run: () => {
            // 与 AI 助手同规则：手改过的论文信息先经确认对话框，不静默覆盖。
            if (paper.userMetaTouched) openDialog("confirm-meta", paper.id);
            else void runPrepareMeta(paper.id, false);
          },
        }
      : { label: "补著录信息", run: () => openDialog("edit-paper", paper.id) };
    nextHint = `著录还缺 ${metaFlags.length - metaDone} 项（摘要 / 年份 / 出处 / 标识符 / 作者）。`;
  } else if (nextEmptyKind) {
    nextAction = { label: `写${NOTE_LABELS[nextEmptyKind].zh}`, run: () => onJump(`note-${nextEmptyKind}`) };
    nextHint = `笔记已写 ${notesWritten} / ${NOTE_DISPLAY_ORDER.length} 块。`;
  } else if (paper.readingStatus !== "read") {
    nextAction = { label: "标记已读", run: () => void markRead(paper.id) };
    nextHint = "五块笔记已写满，读完由你亲手标记。";
  } else {
    nextAction = null;
    nextHint = "解析、著录与五块笔记都已就绪。";
  }

  async function copySectionCitation(heading: (typeof fulltextHeadings)[number]) {
    const title = paper.titleZh || paper.title;
    try {
      await navigator.clipboard.writeText(buildSectionCitation(title, heading));
      setFlash({ tone: "ok", text: `已复制章节引用：§${heading.number} ${heading.text}` });
    } catch {
      // 非安全上下文 / 无剪贴板权限时降级提示（与摘录条复制同口径）。
      setFlash({ tone: "warn", text: "复制失败：当前环境无法访问剪贴板。" });
    }
  }

  /** 标识符一键复制（arXiv / DOI / 作者名单）：与摘录条复制同一降级口径。 */
  async function copyIdentifier(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setFlash({ tone: "ok", text: `已复制${label}。` });
    } catch {
      setFlash({ tone: "warn", text: "复制失败：当前环境无法访问剪贴板。" });
    }
  }

  return (
    <aside className="ef-context" aria-label="论文资料与目录">
      {/* 本篇状态卡：三条进度 + 推荐的下一步动作（低频但一眼拼出全貌）。 */}
      <section className="ef-card" aria-label="本篇状态">
        <h2 className="ef-card-title">本篇状态</h2>
        <ul className="ef-card-progress">
          <li>
            <span>解析</span>
            <b className={parseDone ? "is-done" : parseFailed ? "is-failed" : ""}>{parseLabel}</b>
          </li>
          <li>
            <span>著录</span>
            <span className="ef-card-bar" aria-hidden="true">
              <i style={{ width: `${Math.round((metaDone / metaFlags.length) * 100)}%` }} />
            </span>
            <b>
              {metaDone} / {metaFlags.length}
            </b>
          </li>
          <li>
            <span>笔记</span>
            <span className="ef-card-bar" aria-hidden="true">
              <i style={{ width: `${Math.round((notesWritten / NOTE_DISPLAY_ORDER.length) * 100)}%` }} />
            </span>
            <b>
              {notesWritten} / {NOTE_DISPLAY_ORDER.length}
            </b>
          </li>
        </ul>
        <div className="ef-card-next">
          <span className="ef-card-next-label">下一步</span>
          {nextAction ? (
            <button type="button" onClick={nextAction.run}>
              {nextAction.label}
            </button>
          ) : (
            <b className="is-done">本篇已完成</b>
          )}
          <p>{nextHint}</p>
        </div>
      </section>
      <section className="ef-context-block">
        <h2 className="ef-context-title">阅读状态</h2>
        {/* 三段状态条（未读 → 在读 → 已读）：核心仪式状态一眼可见；
            修改仍走下面的原生 select（表单语义 / 键盘 / 读屏 / 旅程契约都保持）。 */}
        <div className="ef-read-steps" aria-hidden="true">
          {(["unread", "reading", "read"] as const).map((status, index) => {
            const stage = ["unread", "reading", "read"].indexOf(paper.readingStatus);
            return (
              <span
                key={status}
                className={index === stage ? "is-current" : index < stage ? "is-reached" : ""}
              >
                {READING_STATUS_LABELS[status]}
              </span>
            );
          })}
        </div>
        <label className="ef-status-select">
          <Icon name={paper.readingStatus === "read" ? "check" : "file"} />
          <select
            aria-label="修改阅读状态"
            value={paper.readingStatus}
            onChange={(e) => void setReadingStatus(e.target.value as ReadingStatus, paper.id)}
          >
            {(Object.keys(READING_STATUS_LABELS) as ReadingStatus[]).map((status) => (
              <option key={status} value={status}>
                {READING_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <p className="ef-read-date">
          {paper.readingStatus === "read" && paper.readAt
            ? `标记于 ${formatDate(paper.readAt)}`
            : paper.readingStatus === "reading"
              ? readingDayLine(paper.id, paper.createdAt)
              : "阅读状态由你手动标记"}
        </p>
      </section>

      <ContextBlock id="links" title="资料与链接">
        {paper.codeUrl && safeHttpUrl(paper.codeUrl) ? (
          <ExternalResource href={paper.codeUrl} icon="code">
            代码仓库
            <SourceBadge source={paper.fieldSources?.codeUrl} provider={paper.fieldProviders?.codeUrl} />
          </ExternalResource>
        ) : (
          <p className="ef-missing">未提供代码仓库</p>
        )}
        {paper.projectPage && safeHttpUrl(paper.projectPage) ? (
          <ExternalResource href={paper.projectPage} icon="link">
            项目主页
            <SourceBadge source={paper.fieldSources?.projectPage} provider={paper.fieldProviders?.projectPage} />
          </ExternalResource>
        ) : (
          <p className="ef-missing">未提供项目主页</p>
        )}
        <div className="ef-identifier">
          arXiv
          <SourceBadge source={paper.fieldSources?.arxivId} provider={paper.fieldProviders?.arxivId} />
          <span className="ef-identifier-value">
            {arxivAbsUrl(paper.arxivId) ? (
              <button type="button" className="mono ef-id-link" onClick={() => void openExternal(arxivAbsUrl(paper.arxivId))}>
                {paper.arxivId}
              </button>
            ) : (
              <span className="mono">{paper.arxivId || "未提供"}</span>
            )}
            {paper.arxivId ? (
              <button
                type="button"
                className="ef-id-copy"
                aria-label="复制 arXiv 编号"
                title="复制 arXiv 编号"
                onClick={() => void copyIdentifier(paper.arxivId!, "arXiv 编号")}
              >
                <Icon name="copy" />
              </button>
            ) : null}
          </span>
        </div>
        <div className="ef-identifier">
          <span>
            来源
            <SourceBadge source={paper.fieldSources?.venue} provider={paper.fieldProviders?.venue} />
          </span>
          <span className="mono">{[paper.venue, paper.year].filter(Boolean).join(" ") || "未提供"}</span>
        </div>
        <label className="ef-os-select">
          <span>开源状态</span>
          <select
            value={paper.codeOpenSource}
            onChange={(e) => void savePaperPatch(paper.id, { codeOpenSource: e.target.value as OpenSource })}
            aria-label="开源状态"
          >
            <option value="unknown">未知</option>
            <option value="open">开源</option>
            <option value="closed">闭源</option>
            <option value="request">需申请</option>
          </select>
        </label>
        <details className="ef-metadata-details">
          <summary>
            <Icon name="right" />
            作者、机构与 DOI
          </summary>
          <div className="ef-author-details">
            {paper.authors.length ? (
              <>
                <div className="ef-author-copy-row">
                  <button
                    type="button"
                    className="ef-id-copy ef-id-copy-text"
                    onClick={() => void copyIdentifier(paper.authors.map((author) => author.name).join(", "), "作者名单")}
                  >
                    <Icon name="copy" />
                    复制作者名单
                  </button>
                </div>
                {paper.authors.map((author) => (
                  <p key={author.id}>
                    <strong>
                      {author.name}
                      {author.isCorresponding ? " · 通讯" : ""}
                    </strong>
                    <br />
                    {[author.affiliation, author.lab].filter(Boolean).join(" · ") || "机构待补充"}
                  </p>
                ))}
              </>
            ) : (
              <p>作者信息待补充</p>
            )}
            <SourceBadge source={paper.fieldSources?.authors} provider={paper.fieldProviders?.authors} />
            <p>
              DOI
              <SourceBadge source={paper.fieldSources?.doi} provider={paper.fieldProviders?.doi} />
              <br />
              <span className="ef-identifier-value">
                {doiUrl(paper.doi) ? (
                  <button type="button" className="mono ef-id-link" onClick={() => void openExternal(doiUrl(paper.doi))}>
                    {paper.doi}
                  </button>
                ) : (
                  <span className="mono">{paper.doi || "未提供"}</span>
                )}
                {paper.doi ? (
                  <button
                    type="button"
                    className="ef-id-copy"
                    aria-label="复制 DOI"
                    title="复制 DOI"
                    onClick={() => void copyIdentifier(paper.doi!, "DOI")}
                  >
                    <Icon name="copy" />
                  </button>
                ) : null}
              </span>
            </p>
          </div>
        </details>
        {/* 解析状态小卡：状态 / 来源 / 失败原因合并呈现；失败时给出下一步动作。 */}
        {paper.pdfPath ? (
          <div className={`ef-parse-card${parseFailed ? " is-failed" : ""}`} role="group" aria-label="解析状态">
            <p className="ef-parse-head">
              <b>MinerU 解析</b>
              <span className={`ef-parse-state${parseFailed ? " is-error" : parseDone ? " is-ok" : ""}`}>{parseLabel}</span>
              {paper.mineruProvider ? (
                <span className="ef-parse-provider">· 上次用 {providerLabel(paper.mineruProvider)}</span>
              ) : null}
            </p>
            {paper.mineruError ? <p className="ef-parse-reason">{paper.mineruError}</p> : null}
            {parseFailed ? (
              <p className="ef-parse-next">
                下次将用：
                {mineru.configured
                  ? effectiveProvider
                    ? `${providerLabel(effectiveProvider)}（按回退顺序重选）`
                    : "按回退顺序重选（当前探测均未通过，可先测试连接）"
                  : "尚未配置解析源"}
              </p>
            ) : null}
            <div className="ef-parse-actions">
              {!mineru.configured ? (
                <Button type="button" variant="link" onClick={() => void setMode("system")}>
                  配置 MinerU 解析源
                  <Icon name="right" />
                </Button>
              ) : paper.mineruStatus !== "queued" &&
                paper.mineruStatus !== "submitted" &&
                paper.mineruStatus !== "parsing" &&
                paper.mineruStatus !== "done" ? (
                <Button type="button" onClick={() => void retryMineru(paper.id)}>
                  {paper.mineruStatus === "error" || paper.mineruStatus === "cancelled" ? "重新解析" : "发送到 MinerU 解析"}
                </Button>
              ) : null}
              {parseFailed && mineru.configured ? (
                <Button type="button" variant="link" onClick={() => openSystemCard("mineru")}>
                  去设置测试连接
                  <Icon name="right" />
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </ContextBlock>

      <ContextBlock id="toc" title="本页目录">
        <nav className="ef-toc" aria-label="本页目录">
          <a
            href="#abstract"
            className={activeSection === "abstract" ? "is-active" : ""}
            onClick={(e) => {
              e.preventDefault();
              onJump("abstract");
            }}
          >
            <span className="mono">—</span>摘要
          </a>
          <a
            href="#fulltext"
            className={activeSection === "fulltext" ? "is-active" : ""}
            onClick={(e) => {
              e.preventDefault();
              onJump("fulltext");
            }}
          >
            <span className="mono">—</span>解析全文
          </a>
          {visibleHeadings.length ? (
            <div className="ef-toc-sections">
              {visibleHeadings.map((heading) => (
                <div className="ef-toc-section-row" key={heading.id}>
                  <a
                    href={`#${heading.id}`}
                    className={activeSection === heading.id ? "is-active" : ""}
                    title={`跳到 §${heading.number} ${heading.text}`}
                    onClick={(e) => {
                      e.preventDefault();
                      onJump(heading.id);
                    }}
                  >
                    <span className="mono">{heading.number}</span>
                    {heading.text}
                  </a>
                  <button
                    type="button"
                    className="ef-toc-copy"
                    aria-label={`复制引用：§${heading.number} ${heading.text}`}
                    title="复制「论文+小节」引用"
                    onClick={() => void copySectionCitation(heading)}
                  >
                    <Icon name="copy" />
                  </button>
                </div>
              ))}
              {fulltextHeadings.length > TOC_SECTION_LIMIT ? (
                <p className="ef-toc-more">另有 {fulltextHeadings.length - TOC_SECTION_LIMIT} 节，展开解析全文查看。</p>
              ) : null}
            </div>
          ) : null}
          {noteOrder.map((kind, i) => (
            <a
              key={kind}
              href={`#note-${kind}`}
              className={activeSection === `note-${kind}` ? "is-active" : ""}
              onClick={(e) => {
                e.preventDefault();
                onJump(`note-${kind}`);
              }}
            >
              <span className="mono">{pad2(i + 1)}</span>
              {NOTE_LABELS[kind].zh}
            </a>
          ))}
        </nav>
      </ContextBlock>

      <section className="ef-context-block">
        <h2 className="ef-context-title">阅读外观</h2>
        <div className="ef-appearance">
          <div className="ef-appearance-row" role="group" aria-label="正文字号">
            <span className="ef-appearance-label">字号</span>
            <button
              type="button"
              className="ef-appearance-step mono"
              aria-label="减小正文字号"
              title="减小正文字号"
              disabled={appearance.fontStep <= 0}
              onClick={() => onChangeAppearance({ ...appearance, fontStep: Math.max(0, appearance.fontStep - 1) })}
            >
              A−
            </button>
            <span className="ef-appearance-value" aria-live="polite">
              {FONT_STEP_LABELS[appearance.fontStep]}
            </span>
            <button
              type="button"
              className="ef-appearance-step mono"
              aria-label="增大正文字号"
              title="增大正文字号"
              disabled={appearance.fontStep >= FONT_STEPS.length - 1}
              onClick={() =>
                onChangeAppearance({ ...appearance, fontStep: Math.min(FONT_STEPS.length - 1, appearance.fontStep + 1) })
              }
            >
              A+
            </button>
          </div>
          <div className="ef-appearance-row" role="group" aria-label="正文行宽">
            <span className="ef-appearance-label">行宽</span>
            {(Object.keys(WIDTH_SCALES) as ReadWidthStep[]).map((step) => (
              <button
                key={step}
                type="button"
                className="ef-appearance-width"
                aria-pressed={appearance.width === step}
                onClick={() => onChangeAppearance({ ...appearance, width: step })}
              >
                {WIDTH_STEP_LABELS[step]}
              </button>
            ))}
          </div>
          <div className="ef-appearance-actions">
            {appearanceOverride ? (
              <button type="button" onClick={onResetAppearance}>
                恢复默认
              </button>
            ) : null}
            <button type="button" onClick={onApplyAppearanceDefault}>
              应用到所有论文
            </button>
          </div>
          <p className="ef-appearance-hint">本篇调过的档位只记住这一篇；「应用到所有论文」改本机默认。</p>
        </div>
      </section>

      <ContextBlock id="ai" title="AI 助手" icon="spark" className="ef-ai-context ef-dark-surface">
        {hasUsableProvider(settings) ? (
          <p>用于补全论文信息或起草阅读笔记。AI 不会自动把论文标成已读。</p>
        ) : (
          <p>尚未配置 AI 服务，可到设置页配置。手动阅读与笔记不受影响。</p>
        )}
        <div className="ef-ai-buttons">
          <Button
            type="button"
            disabled={!hasUsableProvider(settings) || Boolean(active.length)}
            onClick={() => {
              // AI 不会静默覆盖：手动改过的论文信息先经确认对话框选择保留或覆盖。
              if (paper.userMetaTouched) {
                openDialog("confirm-meta", paper.id);
                return;
              }
              void runPrepareMeta(paper.id, false);
            }}
          >
            <Icon name="file" />
            补全论文信息
          </Button>
          <Button type="button" disabled={Boolean(active.length)} onClick={() => void runRefreshLinks(paper.id)}>
            <Icon name="link" />
            刷新链接
          </Button>
          {lookupHint?.paperId === paper.id && lookupHint.notices.length ? (
            <div className="ef-lookup-hint">
              {lookupHint.notices.map((notice) => (
                <p key={`${notice.source}-${notice.code}`}>{notice.message}</p>
              ))}
              <button type="button" onClick={() => void setMode("system")}>
                设置 → 文献库
              </button>
            </div>
          ) : null}
          <Button
            type="button"
            disabled={!hasUsableProvider(settings) || Boolean(active.length)}
            onClick={() => void runDraftNotes(paper.id)}
          >
            <Icon name="edit" />
            起草阅读笔记
          </Button>
        </div>
        {active.map((job) => (
          <div key={job.id} className="ef-job-row">
            <span>
              {job.status === "running" ? <i className="ef-pulse" aria-hidden="true" /> : null}
              {JOB_TYPE_LABELS[job.type]} · {JOB_STATUS_LABELS[job.status]}
            </span>
            <Button type="button" size="sm" onClick={() => void cancelJob(job.id)}>
              取消
            </Button>
          </div>
        ))}
        {hasUsableProvider(settings) ? null : (
          <Button type="button" variant="link" onClick={() => void setMode("system")}>
            配置 AI 服务
            <Icon name="right" />
          </Button>
        )}
      </ContextBlock>
    </aside>
  );
}

export function ReadingStage({
  focus,
  onToggleFocus,
  listOpen,
  onToggleList,
  contextOpen,
  onToggleContext,
}: {
  focus: boolean;
  onToggleFocus: () => void;
  listOpen: boolean;
  onToggleList: () => void;
  contextOpen: boolean;
  onToggleContext: () => void;
}) {
  const paper = useField((s) => s.paper);
  const mode = useField((s) => s.mode);
  const search = useField((s) => s.search);
  const openDialog = useField((s) => s.openDialog);
  const setNoteDraft = useField((s) => s.setNoteDraft);
  const setFlash = useField((s) => s.setFlash);
  const saveAllNoteDrafts = useField((s) => s.saveAllNoteDrafts);
  const navigatePapers = useField((s) => s.navigatePapers);
  const markRead = useField((s) => s.markRead);
  const drafts = useField((s) => s.drafts);
  const papers = useField((s) => s.papers);
  const archive = useField((s) => s.archive);
  const intake = useField((s) => s.intake);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("abstract");
  // 解析全文里最近一次选中：供「摘到笔记」浮条与笔记编辑器的「引用解析全文」共享。
  const [fulltextPick, setFulltextPick] = useState<FulltextSelection | null>(null);
  // 五块笔记的显示布局（顺序 + 折叠）：本机偏好，改动即存。
  const [noteLayout, setNoteLayout] = useState<NoteLayout>(() => loadNoteLayout());
  // 正文阅读外观（字号/行宽）：本机默认 + 按论文覆盖，改动即存（lib 写穿 localStorage）。
  const [appearanceStore, setAppearanceStore] = useState<AppearanceStore>(() => loadAppearanceStore());
  // 全文并读（半高分屏）：上半屏解析全文、下半屏摘要与笔记，边读全文边写笔记。
  const [fulltextSplit, setFulltextSplit] = useState(false);
  const fulltextHeadings = useMemo(
    () => (paper ? extractFulltextHeadings(paper.parsedMarkdown) : []),
    [paper?.parsedMarkdown],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveNoteLayout(noteLayout);
  }, [noteLayout]);

  // ---- 每篇论文的阅读现场：滚动位置 / 所在小节 / 解析全文展开状态 ----
  // spotRef 由滚动监听与目录高亮共同维护；离开（切论文 / 卸载）时兜底存一次。
  const spotRef = useRef<{ top: number; section: string }>({ top: 0, section: "abstract" });
  // 恢复现场后短暂显示「已回到上次阅读位置」浮标（回到顶部 / 关闭，8 秒自动收起）。
  const [spotChip, setSpotChip] = useState(false);
  // 五块笔记写满的一次性轻庆祝（同篇只在 4→5 的转变时触发，重开已写满的论文不庆祝）。
  const [noteCelebration, setNoteCelebration] = useState(false);
  const lastNotesSeen = useRef<{ paperId: string | null; written: number }>({ paperId: null, written: -1 });
  // ↑↓ / 点击切换论文时的读屏播报：第几篇、共几篇、标题。
  const [paperAnnounce, setPaperAnnounce] = useState("");
  const lastAnnouncedPaper = useRef<string | null>(null);

  useEffect(() => {
    const id = paper?.id ?? null;
    const prev = lastAnnouncedPaper.current;
    lastAnnouncedPaper.current = id;
    if (!id || !paper || !prev || prev === id) return;
    const state = useField.getState();
    const list = state.mode === "archive" ? state.archive : state.mode === "intake" ? state.intake : state.papers;
    const index = list.findIndex((item) => item.id === id);
    const title = paper.titleZh || paper.title;
    setPaperAnnounce(
      index >= 0 ? `已切换到第 ${index + 1} 篇（共 ${list.length} 篇）：《${title}》` : `已切换论文：《${title}》`,
    );
  }, [paper?.id]);

  /** 跳转链接的落点：移动焦点并滚动到目标（键盘与读屏共用同一路径）。 */
  function skipTo(target: "paper-title" | "notes-heading") {
    const el = document.getElementById(target);
    if (!el) return;
    el.focus();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }

  useEffect(() => {
    spotRef.current.section = activeSection;
  }, [activeSection]);

  // 滚动时节流记现场（400ms 一次，不做逐帧写 localStorage）。
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !paper) return;
    let lastSave = 0;
    const persist = (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastSave < 400) return;
      lastSave = now;
      saveReadingSpot(paper.id, {
        top: root.scrollTop,
        section: spotRef.current.section,
        fulltextOpen: Boolean(document.getElementById("fulltext")?.hasAttribute("open")),
        at: now,
      });
    };
    const onScroll = () => {
      spotRef.current.top = root.scrollTop;
      persist(false);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      // 离开这篇论文前兜底存一次（切论文 / 切模式 / 关窗前的最后一次位置）。
      persist(true);
    };
  }, [paper?.id]);

  // 打开论文：恢复上次的滚动位置与小节（目录高亮该节），并短暂提示可回到顶部。
  useEffect(() => {
    setSpotChip(false);
    if (!paper) return;
    const spot = loadReadingSpots()[paper.id];
    if (!spot) return;
    spotRef.current = { top: spot.top, section: spot.section };
    const root = scrollRef.current;
    const frame = requestAnimationFrame(() => {
      if (root && spot.top > 0) root.scrollTop = spot.top;
      if (spot.fulltextOpen) document.getElementById("fulltext")?.setAttribute("open", "");
      setActiveSection(spot.section);
      if (spot.top > 0) setSpotChip(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [paper?.id]);

  // 浮标 8 秒后自动收起（不依赖 timer 的显式按钮路径见渲染处）。
  useEffect(() => {
    if (!spotChip) return;
    const timer = window.setTimeout(() => setSpotChip(false), 8000);
    return () => window.clearTimeout(timer);
  }, [spotChip]);

  // 五块笔记写满的轻庆祝：只有「同一篇论文内补上最后一块」这一次转变触发
  // （打开一篇本来就写满的论文不算——那不是刚完成的喜悦）。
  useEffect(() => {
    const id = paper?.id ?? null;
    if (!paper) {
      lastNotesSeen.current = { paperId: null, written: -1 };
      return;
    }
    const written = NOTE_DISPLAY_ORDER.filter((kind) => paper.notes[kind].content.trim()).length;
    const last = lastNotesSeen.current;
    const samePaper = last.paperId === id;
    if (
      samePaper &&
      last.written >= 0 &&
      last.written < NOTE_DISPLAY_ORDER.length &&
      written === NOTE_DISPLAY_ORDER.length
    ) {
      setNoteCelebration(true);
      setFlash({ tone: "ok", text: "五块阅读笔记都写满了——这一篇被你完整读过。" });
      const timer = window.setTimeout(() => setNoteCelebration(false), 1200);
      lastNotesSeen.current = { paperId: id, written };
      return () => window.clearTimeout(timer);
    }
    lastNotesSeen.current = { paperId: id, written };
  }, [paper]);

  function backToTop() {
    setSpotChip(false);
    const root = scrollRef.current;
    if (!root) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // jsdom 等无布局环境没有 Element.scrollTo：退化为直接置顶。
    if (typeof root.scrollTo === "function") root.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    else root.scrollTop = 0;
    setActiveSection("abstract");
  }

  function toggleNoteCollapsed(kind: NoteKind) {
    setNoteLayout((prev) => ({
      ...prev,
      collapsed: { ...prev.collapsed, [kind]: !prev.collapsed[kind] },
    }));
  }

  function moveNoteBlock(kind: NoteKind, direction: "up" | "down") {
    setNoteLayout((prev) => ({ ...prev, order: moveNoteKindInOrder(prev.order, kind, direction) }));
  }

  function changeAppearance(next: ReadingAppearance) {
    if (!paper) return;
    setAppearanceStore((prev) => setPaperAppearance(prev, paper.id, next));
  }

  function resetAppearance() {
    if (!paper) return;
    setAppearanceStore((prev) => clearPaperAppearance(prev, paper.id));
  }

  function applyAppearanceDefault() {
    setAppearanceStore((prev) => setDefaultAppearance(prev, getAppearance(prev, paper?.id)));
  }

  useEffect(() => {
    setMenuOpen(false);
    setActiveSection("abstract");
    setFulltextPick(null);
  }, [paper?.id]);

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !paper) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(".ef-abstract, .ef-fulltext, .ef-note"));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
            break;
          }
        }
      },
      { root, rootMargin: "-2% 0px -70% 0px", threshold: 0 },
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [paper?.id]);

  // 滚动动态：仅当阅读滚动越过 0 时在 .ef-read 上写 data-scrolled（跨界才写，
  // 不做逐帧 DOM 写入），工具条据此提白加深分隔线。passive 监听，无滚动逻辑负担。
  useEffect(() => {
    const root = scrollRef.current;
    const stage = root?.closest(".ef-read");
    if (!root || !stage) return;
    const setScrolled = (scrolled: boolean) => {
      if (scrolled) stage.setAttribute("data-scrolled", "true");
      else stage.removeAttribute("data-scrolled");
    };
    let scrolled = root.scrollTop > 0;
    setScrolled(scrolled);
    const onScroll = () => {
      const next = root.scrollTop > 0;
      if (next === scrolled) return;
      scrolled = next;
      setScrolled(next);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      setScrolled(false);
    };
  }, [paper?.id]);

  function jump(id: string) {
    // 跳到解析全文的某一节：折叠着的时候先展开，锚点才可见可滚。
    if (id.startsWith("ft-sec-")) document.getElementById("fulltext")?.setAttribute("open", "");
    const root = scrollRef.current;
    const target = root?.querySelector<HTMLElement>(`#${id}`);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    setActiveSection(id);
    if (contextOpen) onToggleContext();
  }

  function startEdit(kind: NoteKind) {
    if (!paper) return;
    // 已有草稿就接着编辑；没有则以当前内容开一份草稿。
    if (useField.getState().drafts[paper.id]?.[kind] === undefined) {
      setNoteDraft(paper.id, kind, paper.notes[kind].content);
    }
    requestAnimationFrame(() => jump(`note-${kind}`));
  }

  /** ⌘Enter 保存成功后：跳到当前块之后的下一块空笔记（写完的块不再打扰）。 */
  function startNextEmptyNote(fromKind: NoteKind) {
    if (!paper) return;
    const order = noteLayout.order;
    const start = order.indexOf(fromKind);
    for (let step = 1; step <= order.length; step += 1) {
      const kind = order[(start + step) % order.length];
      const content = useField.getState().drafts[paper.id]?.[kind] ?? paper.notes[kind].content;
      if (!content.trim()) {
        startEdit(kind);
        return;
      }
    }
  }

  if (!paper) {
    const searching = mode === "field" && search.trim().length > 0;
    const emptyDomain = mode === "field" && !searching;
    return (
      <section className="ef-read" id="stage" aria-labelledby="read-empty">
        <div className="ef-toolbar">
          <Button
            type="button"
            variant="text"
            className="ef-list-back"
            aria-expanded={listOpen}
            onClick={onToggleList}
          >
            <Icon name="menu" />
            论文列表
          </Button>
        </div>
        <div className="ef-read-scroll">
          <div className="ef-reading-grid">
            <Empty
              title={searching ? "没有符合条件的论文" : emptyDomain ? "此领域还没有论文" : "选择一篇论文"}
              body={
                searching
                  ? "可以调整搜索词，或清空搜索后继续阅读。"
                  : emptyDomain
                    ? "使用论文列表底部的「添加论文」导入第一篇论文。"
                    : "从左侧列表选择一篇论文，阅读摘要、撰写阅读笔记，或直接打开 PDF。"
              }
            />
          </div>
        </div>
      </section>
    );
  }

  const title = paper.titleZh || paper.title;
  const english = paper.titleZh ? paper.title : "";
  // 选中的论文只是被搜索或筛选挡在列表外时仍保持打开（不自动跳到别的论文），这里说明一下。
  const visibleList = mode === "archive" ? archive : mode === "intake" ? intake : papers;
  const outOfList = mode !== "system" && !visibleList.some((item) => item.id === paper.id);
  const readingStatusLabel = READING_STATUS_LABELS[paper.readingStatus];
  const notesWritten = NOTE_DISPLAY_ORDER.filter((kind) => paper.notes[kind].content.trim()).length;
  const notesFull = notesWritten === NOTE_DISPLAY_ORDER.length;
  // 下一块空笔记（草稿优先于已存内容）：进度胶囊点击的落点。
  const nextEmptyNote = noteLayout.order.find((kind) => {
    const content = drafts[paper.id]?.[kind] ?? paper.notes[kind].content;
    return !content.trim();
  });
  const draftCount = NOTE_DISPLAY_ORDER.filter((kind) => drafts[paper.id]?.[kind] !== undefined).length;
  // 翻页条的位置读数：当前论文在可见列表中的序号（被搜索挡在列表外时读数退化为 —）。
  const pagerIndex = visibleList.findIndex((item) => item.id === paper.id);
  const pagerTotal = visibleList.length;
  const fulltextStatus = paper.parsedMarkdown.trim()
    ? "MinerU 已解析"
    : paper.mineruStatus
      ? `MinerU · ${MINERU_STATUS_LABELS[paper.mineruStatus]}`
      : "尚未解析";
  // 本篇生效的阅读外观：字号/行宽缩放变量写到舞台上（正文阶梯随动，界面控件不动）。
  const appearance = getAppearance(appearanceStore, paper.id);
  const appearanceOverride = hasPaperAppearance(appearanceStore, paper.id);
  const appearanceStyle = {
    "--pf-read-scale": String(FONT_STEPS[appearance.fontStep]),
    "--pf-read-width-scale": String(WIDTH_SCALES[appearance.width]),
  } as CSSProperties;
  const appearanceProps = {
    appearance,
    appearanceOverride,
    onChangeAppearance: changeAppearance,
    onResetAppearance: resetAppearance,
    onApplyAppearanceDefault: applyAppearanceDefault,
  };
  const context = (
    <ContextPanel
      paper={paper}
      activeSection={activeSection}
      onJump={jump}
      noteOrder={noteLayout.order}
      {...appearanceProps}
    />
  );

  return (
    <section
      className={["ef-read has-context", fulltextSplit && paper.parsedMarkdown.trim() ? "is-fulltext-split" : ""]
        .filter(Boolean)
        .join(" ")}
      id="stage"
      aria-labelledby="paper-title"
      style={appearanceStyle}
    >
      {/* 无障碍：切换论文的读屏播报（第几篇 / 共几篇 / 标题）。 */}
      <p className="sr-only" role="status">
        {paperAnnounce}
      </p>
      {/* 无障碍：跳转链接——键盘用户跳过工具条直达正文 / 笔记。 */}
      <nav className="ef-skip" aria-label="跳转链接">
        <a
          href="#paper-title"
          onClick={(e) => {
            e.preventDefault();
            skipTo("paper-title");
          }}
        >
          跳到正文
        </a>
        <a
          href="#notes-heading"
          onClick={(e) => {
            e.preventDefault();
            skipTo("notes-heading");
          }}
        >
          跳到笔记
        </a>
      </nav>
      <div className="ef-toolbar">
        <Button
          type="button"
          variant="text"
          className="ef-list-back"
          aria-expanded={listOpen}
          onClick={onToggleList}
        >
          <Icon name="menu" />
          论文列表
        </Button>
        {/* 两层滑轨：平时显示所在领域；正文滚过 0（.ef-read[data-scrolled]）后
            论文标题从下方滑入，标题离开视口时工具条仍保留「正在读哪篇」。 */}
        <span className="ef-toolbar-label">
          <span className="ef-toolbar-crumb">
            <Icon name="file" />
            论文详情<span className="ef-toolbar-sep">/</span>
            {paper.domain.name}
          </span>
          <span className="ef-toolbar-title" aria-hidden="true">
            {title}
          </span>
        </span>
        <span className="ef-toolbar-spacer" />
        {/* 工具条按职责分两组：视图切换（专注 / 资料）只改布局，用安静的文字按钮；
            分隔线之后是对这篇论文的动作：「打开 PDF」是全屏唯一的 primary，编辑论文信息 /
            移动 / 删除这类低频管理操作收进最右的「⋯」。笔记不在这里：每块笔记就地编辑。
            所有控件同高，基线对齐。 */}
        <Button
          type="button"
          variant="text"
          className="ef-focus-btn"
          aria-pressed={focus}
          title={focus ? "退出专注，恢复论文列表与资料栏" : "隐藏论文列表与资料栏，只留正文"}
          onClick={onToggleFocus}
        >
          <Icon name="focus" />
          {focus ? "退出专注" : "专注阅读"}
        </Button>
        <Button
          type="button"
          variant="text"
          className="ef-context-toggle"
          title="论文资料、链接与本页目录"
          onClick={onToggleContext}
        >
          <Icon name="inbox" />
          资料
        </Button>
        {paper.parsedMarkdown.trim() ? (
          <Button
            type="button"
            variant="text"
            className="ef-split-btn"
            aria-pressed={fulltextSplit}
            title={fulltextSplit ? "收起解析全文面板，回到单栏" : "上半屏解析全文、下半屏摘要与笔记，边读全文边写笔记"}
            onClick={() => setFulltextSplit((value) => !value)}
          >
            <Icon name="grid" />
            {fulltextSplit ? "退出并读" : "全文并读"}
          </Button>
        ) : null}
        <span className="ef-toolbar-divider" aria-hidden="true" />
        {paper.pdfPath ? (
          <Button
            type="button"
            className="ef-pdf-action"
            variant="primary"
            title="用系统默认阅读器打开本地 PDF"
            onClick={() => {
              void openLocalPdf(paper.pdfPath!).catch((err: unknown) => {
                setFlash({
                  tone: "error",
                  text: err instanceof Error ? err.message : "无法打开 PDF",
                });
              });
            }}
          >
            <Icon name="file" />
            打开 PDF
          </Button>
        ) : safeHttpUrl(arxivPdfUrl(paper.arxivId) ?? paper.pdfUrl) ? (
          <Button
            type="button"
            className="ef-pdf-action"
            variant="primary"
            title="在浏览器中打开在线 PDF"
            onClick={() => void openExternal(arxivPdfUrl(paper.arxivId) ?? paper.pdfUrl)}
          >
            <Icon name="external" />
            打开 PDF
          </Button>
        ) : (
          <Button
            type="button"
            className="ef-pdf-action"
            title="这篇论文还没有 PDF，可在论文信息中选择本地文件或填写公开链接"
            onClick={() => openDialog("edit-paper", paper.id)}
          >
            <Icon name="file" />
            补充 PDF
          </Button>
        )}
        <div className="ef-menu-wrap" ref={menuRef}>
          <Button
            type="button"
            variant="text"
            className="ef-icon-btn ef-more-btn"
            aria-label="更多操作"
            title="更多操作"
            aria-expanded={menuOpen}
            aria-controls="action-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Icon name="more" />
          </Button>
          <div className="ef-action-menu" id="action-menu" hidden={!menuOpen}>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                openDialog("edit-paper", paper.id);
              }}
            >
              <Icon name="edit" />
              <span className="ef-menu-text">
                编辑论文信息
                <small>标题、作者、摘要、PDF 与链接</small>
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                openDialog("move-paper", paper.id);
              }}
            >
              <Icon name="inbox" />
              移动到其他领域
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                setMenuOpen(false);
                openDialog("delete-paper", paper.id);
              }}
            >
              <Icon name="trash" />
              删除论文…
            </button>
          </div>
        </div>
      </div>

      <div className="ef-read-scroll" ref={scrollRef} id="read-scroll" tabIndex={0} aria-label="正文阅读区">
        {/* 全文并读面板：置顶半高分区（自带小节目录），与摘要/笔记同一舞台、互不遮挡。 */}
        {fulltextSplit && paper.parsedMarkdown.trim() ? (
          <section className="ef-fulltext-panel" aria-label="解析全文并读面板">
            <header className="ef-fulltext-panel-head">
              <h2 className="ef-fulltext-panel-title">解析全文</h2>
              <small>{fulltextStatus}</small>
              <span className="ef-fulltext-panel-spacer" aria-hidden="true" />
              {fulltextHeadings.length ? (
                <label className="ef-fulltext-panel-toc" title="按小节跳转">
                  <span>小节</span>
                  <select
                    aria-label="跳到小节"
                    value=""
                    onChange={(e) => {
                      const id = e.target.value;
                      if (id) jump(id);
                    }}
                  >
                    <option value="">跳到小节…</option>
                    {fulltextHeadings.map((heading) => (
                      <option key={heading.id} value={heading.id}>
                        §{heading.number} {heading.text}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <Button type="button" size="sm" variant="text" onClick={() => setFulltextSplit(false)}>
                收起
              </Button>
            </header>
            <div className="ef-fulltext-panel-body">
              <FulltextDoc paper={paper} onPick={setFulltextPick} />
            </div>
          </section>
        ) : null}
        <div className="ef-reading-grid">
          <article className="ef-document" id="document" key={paper.id}>
            <div className="ef-paper-category">
              {paper.domain.code ? <span className="ef-code">{paper.domain.code}</span> : null}
              <span>{paper.domain.name}</span>
              <i className="ef-category-rule" aria-hidden="true" />
              <span>{readingStatusLabel}</span>
              {/* 常驻笔记进度胶囊：一眼看到整体完成度；点击跳到下一块空笔记开写。
                  写满的那一刻做一次轻量庆祝（scale 弹一下，见 is-celebrate）。 */}
              <button
                type="button"
                className={`ef-note-pill${notesFull ? " is-full" : ""}${noteCelebration ? " is-celebrate" : ""}`}
                aria-label={
                  notesFull
                    ? "五块笔记已写满"
                    : `本篇已完成 ${notesWritten} / ${NOTE_DISPLAY_ORDER.length} 块笔记，跳到下一块空笔记`
                }
                title={notesFull ? "五块笔记已写满" : "跳到下一块空笔记"}
                onClick={() => {
                  if (nextEmptyNote) startEdit(nextEmptyNote);
                  else jump(`note-${noteLayout.order[0]}`);
                }}
              >
                {notesFull ? <Icon name="check" /> : null}
                笔记 {notesWritten}
                <span className="mono">/{NOTE_DISPLAY_ORDER.length}</span>
              </button>
            </div>
            {outOfList ? (
              <p className="ef-out-of-list" role="note">
                这篇论文不在当前列表中（搜索或筛选条件不匹配），仍可继续阅读与编辑。
              </p>
            ) : null}
            <h1 id="paper-title" className="ef-read-title" tabIndex={-1}>
              {title}
            </h1>
            {english ? <p className="ef-paper-en">{english}</p> : null}
            <p className="ef-paper-author-line">
              {paper.authors.length
                ? paper.authors.map((author) => author.name).join(" · ")
                : "作者信息待补充"}
            </p>
            <section className="ef-abstract" id="abstract">
              <h2 className="ef-section-label">
                <span>
                  摘要
                  <SourceBadge source={paper.fieldSources?.abstract} provider={paper.fieldProviders?.abstract} />
                </span>
                <i className="ef-section-rule" aria-hidden="true" />
              </h2>
              {paper.abstract ? (
                <p>{paper.abstract}</p>
              ) : (
                <p className="ef-empty-note">
                  尚未填写摘要。摘要属于论文信息，不是笔记：
                  <Button type="button" variant="link" onClick={() => openDialog("edit-paper", paper.id)}>
                    编辑论文信息
                  </Button>
                </p>
              )}
            </section>
            <div className="ef-notes-heading">
              <h2 className="ef-section-label" id="notes-heading" tabIndex={-1}>
                <span>阅读笔记</span>
                <small>
                  已写 {notesWritten} / {NOTE_DISPLAY_ORDER.length}
                </small>
                <i className="ef-section-rule" aria-hidden="true" />
              </h2>
              {/* 有草稿时常驻统一出口：逐块保存不再需要挨个点。 */}
              {draftCount ? (
                <Button
                  type="button"
                  size="sm"
                  className="ef-save-all"
                  title="保存这篇论文当前全部未保存的笔记草稿"
                  onClick={() => void saveAllNoteDrafts(paper.id)}
                >
                  保存本篇全部（{draftCount} 处草稿）
                </Button>
              ) : null}
            </div>
            <p className="ef-notes-caption">每块笔记都标注来源：手动笔记或 AI 起草；AI 不会静默覆盖你改过的笔记。</p>
            {noteLayout.order.map((kind, index) => (
              <NoteEditor
                key={kind}
                kind={kind}
                index={index}
                paper={paper}
                onStart={() => startEdit(kind)}
                onSavedNext={() => startNextEmptyNote(kind)}
                fulltextPick={fulltextPick}
                collapsed={Boolean(noteLayout.collapsed[kind])}
                onToggleCollapsed={() => toggleNoteCollapsed(kind)}
                onMove={(direction) => moveNoteBlock(kind, direction)}
                canMoveUp={index > 0}
                canMoveDown={index < noteLayout.order.length - 1}
              />
            ))}
            {/* 并读模式下全文在上方面板里，折叠区不重复渲染（锚点由面板提供）。 */}
            {!fulltextSplit ? (
              <details className="ef-fulltext" id="fulltext">
                <summary className="ef-section-label">
                  <span>解析全文</span>
                  <small>{fulltextStatus}</small>
                  <i className="ef-section-rule" aria-hidden="true" />
                  <Icon name="right" />
                </summary>
                {paper.parsedMarkdown.trim() ? (
                  <FulltextDoc paper={paper} onPick={setFulltextPick} />
                ) : (
                  <p className="ef-empty-note">尚未解析出全文。导入 PDF 并启用解析源后，这里会显示解析结果。</p>
                )}
              </details>
            ) : null}
          </article>
        </div>
      </div>
      {/* 恢复阅读现场后短暂出现的浮标：告知回到上次位置，并可一键回到顶部。 */}
      {spotChip ? (
        <div className="ef-read-spot" role="status">
          <span>已回到上次阅读位置 · {spotSectionLabel(activeSection, fulltextHeadings)}</span>
          <button type="button" onClick={backToTop}>
            回到顶部
          </button>
          <button type="button" className="ef-read-spot-close" aria-label="收起提示" onClick={() => setSpotChip(false)}>
            <Icon name="close" />
          </button>
        </div>
      ) : null}
      {/* 专注模式收起列表与资料栏后，正文区只靠 ↑↓ 翻页：底部保留一条极简翻页条，
          上一篇 / 标已读 / 下一篇 + 位置读数，给出可视出口。 */}
      {focus ? (
        <nav className="ef-focus-pager" aria-label="专注模式翻页">
          <Button
            type="button"
            variant="text"
            size="sm"
            onClick={() => void navigatePapers(-1)}
            disabled={pagerIndex <= 0}
            aria-label="上一篇论文"
          >
            <Icon name="up" />
            上一篇
          </Button>
          <span className="ef-focus-pager-pos mono" aria-live="polite">
            {pagerIndex < 0 ? "—" : `${pagerIndex + 1} / ${pagerTotal}`}
          </span>
          {paper.readingStatus === "read" ? (
            <Button type="button" variant="text" size="sm" disabled title="这篇论文已标记为已读">
              <Icon name="check" />
              已读
            </Button>
          ) : (
            <Button type="button" variant="text" size="sm" onClick={() => void markRead(paper.id)}>
              <Icon name="check" />
              标已读
            </Button>
          )}
          <Button
            type="button"
            variant="text"
            size="sm"
            onClick={() => void navigatePapers(1)}
            disabled={pagerIndex < 0 || pagerIndex >= pagerTotal - 1}
            aria-label="下一篇论文"
          >
            下一篇
            <Icon name="down" />
          </Button>
        </nav>
      ) : null}
      {context}
      <Dialog
        open={contextOpen}
        title="论文资料与目录"
        onClose={onToggleContext}
        className="context-drawer"
      >
        <ContextPanel paper={paper} activeSection={activeSection} onJump={jump} noteOrder={noteLayout.order} {...appearanceProps} />
      </Dialog>
    </section>
  );
}
