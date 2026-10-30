import { useEffect, useMemo, useState } from "react";
import { latestAiWrite, noteVersions, type AiWriteRecord, type NoteVersion } from "../lib/aiAudit";
import { BIBLIO_PROVIDER_LABELS, META_FIELD_LABELS, NOTE_DISPLAY_ORDER, NOTE_LABELS, type NoteKind } from "../lib/types";
import { formatDate } from "../lib/util";
import { useField } from "../store";
import { Button, Dialog, Icon } from "./ui";

/** diff 行里旧值 / 新值的显示上限：够认出内容即可，整段对照在正文里看。 */
const DIFF_VALUE_CHARS = 80;
/** 每块笔记在版本区最多列出的版本数。 */
const VERSIONS_SHOWN = 6;

function clampText(text: string): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > DIFF_VALUE_CHARS ? `${chars.slice(0, DIFF_VALUE_CHARS).join("")}…` : chars.join("");
}

function versionAt(version: NoteVersion): string {
  return formatDate(new Date(version.at).toISOString());
}

/**
 * AI 写入的变更查看与撤销（dialog="ai-diff"）：列出最近一次 AI 补全 / 起草改了什么
 * （旧值 → 新值），可一键撤销本次写入；笔记块附带会话内版本列表，可恢复某一版。
 */
export function AiDiffDialog() {
  const dialog = useField((s) => s.dialog);
  const dialogPaperId = useField((s) => s.dialogPaperId);
  const closeDialog = useField((s) => s.closeDialog);
  const undoAiWrite = useField((s) => s.undoAiWrite);
  const restoreNoteVersion = useField((s) => s.restoreNoteVersion);
  const open = dialog === "ai-diff";
  const [busy, setBusy] = useState(false);
  const [record, setRecord] = useState<AiWriteRecord | null>(null);
  const [restoredAt, setRestoredAt] = useState(0);

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setRecord(dialogPaperId ? latestAiWrite(dialogPaperId) : null);
  }, [open, dialogPaperId]);

  // 版本恢复后刷新版本列表（noteVersions 是内存数据，靠状态位触发重读）。
  useEffect(() => {
    if (!open) setRestoredAt(0);
  }, [open]);

  const versionsByKind = useMemo(() => {
    void restoredAt;
    if (!open || !dialogPaperId) return {} as Partial<Record<NoteKind, NoteVersion[]>>;
    return Object.fromEntries(
      NOTE_DISPLAY_ORDER.map((kind) => [kind, noteVersions(dialogPaperId, kind).slice(0, VERSIONS_SHOWN)]),
    ) as Partial<Record<NoteKind, NoteVersion[]>>;
  }, [open, dialogPaperId, restoredAt]);

  async function undo() {
    if (!record || busy) return;
    setBusy(true);
    try {
      await undoAiWrite(record.id);
      closeDialog();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="AI 写入的变更"
      onClose={closeDialog}
      className="is-wide"
      footer={
        <>
          <Button type="button" onClick={closeDialog}>
            关闭
          </Button>
          {record ? (
            <Button type="button" variant="danger" disabled={busy} onClick={() => void undo()}>
              {busy ? "撤销中…" : "撤销本次 AI 写入"}
            </Button>
          ) : null}
        </>
      }
    >
      {!record ? (
        <p>这次会话里还没有这篇论文的 AI 写入记录。快照与版本只保存在本次会话中，重启后会清空。</p>
      ) : (
        <>
          <p>
            {record.kind === "meta" ? "补全论文信息" : "起草阅读笔记"} · {formatDate(new Date(record.at).toISOString())} ·
            《{record.paperTitle}》。AI 写入之后你又改过的字段 / 笔记块不会被撤销覆盖。
          </p>
          {record.meta ? (
            <section className="ef-diff-block" aria-label="字段变更">
              <h3>字段变更（{record.meta.changes.length}）</h3>
              <ul className="ef-diff-list">
                {record.meta.changes.map((change) => (
                  <li key={change.field}>
                    <span className="ef-diff-field">{META_FIELD_LABELS[change.field]}</span>
                    <span className="ef-diff-pair">
                      <del>{clampText(change.from) || "（空白）"}</del>
                      <Icon name="right" />
                      <ins>{clampText(change.to) || "（空白）"}</ins>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {record.notes ? (
            <section className="ef-diff-block" aria-label="笔记块变更">
              <h3>笔记块变更（{record.notes.changes.length}）</h3>
              <ul className="ef-diff-list">
                {record.notes.changes.map((change) => (
                  <li key={change.kind}>
                    <span className="ef-diff-field">{NOTE_LABELS[change.kind].zh}</span>
                    <span className="ef-diff-pair">
                      <del>{clampText(change.from) || "（空白）"}</del>
                      <Icon name="right" />
                      <ins>{clampText(change.to) || "（空白）"}</ins>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="ef-diff-block" aria-label="笔记版本">
            <h3>笔记版本（本次会话）</h3>
            <p className="ef-diff-note">
              AI 写入与手动保存都会记一个版本；点击「恢复」把该块写回所选版本（作为手动保存落库）。
              版本只保存在本次会话中，重启后清空。
            </p>
            {NOTE_DISPLAY_ORDER.filter((kind) => (versionsByKind[kind]?.length ?? 0) > 0).map((kind) => (
              <div className="ef-diff-versions" key={kind}>
                <h4>{NOTE_LABELS[kind].zh}</h4>
                <ul>
                  {(versionsByKind[kind] ?? []).map((version, index) => (
                    <li key={`${version.at}-${index}`}>
                      <span className={`ef-diff-version-by is-${version.by}`}>
                        {version.by === "ai" ? "AI 写入" : "手动保存"}
                      </span>
                      <span className="ef-diff-version-at mono">{versionAt(version)}</span>
                      <span className="ef-diff-version-text">{clampText(version.content) || "（空白）"}</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="text"
                        onClick={() => {
                          if (!dialogPaperId) return;
                          void restoreNoteVersion(dialogPaperId, kind, version.content).then(() =>
                            setRestoredAt((value) => value + 1),
                          );
                        }}
                      >
                        恢复
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        </>
      )}
    </Dialog>
  );
}

/**
 * 干跑预览（dialog="ai-preview"）：补全论文信息的「先预览不写入」结果。
 * 列出确认后将写入的字段（当前值 → 将写入的值 + 拟写入来源），用户确认才落库；
 * 预览期间手改的字段在写入时仍受 meta_rev 条件更新保护。
 */
export function MetaPreviewDialog() {
  const dialog = useField((s) => s.dialog);
  const metaPreview = useField((s) => s.metaPreview);
  const dismissMetaPreview = useField((s) => s.dismissMetaPreview);
  const applyMetaPreview = useField((s) => s.applyMetaPreview);
  const open = dialog === "ai-preview" && Boolean(metaPreview);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);

  async function apply() {
    if (busy) return;
    setBusy(true);
    try {
      await applyMetaPreview();
    } finally {
      setBusy(false);
    }
  }

  if (!metaPreview) return null;
  return (
    <Dialog
      open={open}
      title="补全预览（尚未写入）"
      onClose={dismissMetaPreview}
      className="is-wide"
      footer={
        <>
          <Button type="button" onClick={dismissMetaPreview}>
            不写入
          </Button>
          <Button type="button" variant="primary" disabled={busy || !metaPreview.changes.length} onClick={() => void apply()}>
            {busy ? "写入中…" : `写入 ${metaPreview.changes.length} 项`}
          </Button>
        </>
      }
    >
      <p>
        《{metaPreview.paperTitle}》· 这次补全只做了查询与生成，还没有写库。下面是确认后将写入的字段；
        预览期间你手动改过的内容在写入时仍会保留。
      </p>
      {metaPreview.changes.length ? (
        <section className="ef-diff-block" aria-label="将写入的字段">
          <ul className="ef-diff-list">
            {metaPreview.changes.map((change) => (
              <li key={change.field}>
                <span className="ef-diff-field">{META_FIELD_LABELS[change.field]}</span>
                <span className="ef-diff-pair">
                  <del>{clampText(change.from) || "（空白）"}</del>
                  <Icon name="right" />
                  <ins>{clampText(change.to) || "（空白）"}</ins>
                </span>
                <span className="ef-preview-source">
                  {change.incoming === "api"
                    ? `来源：数据库${change.provider ? ` · ${BIBLIO_PROVIDER_LABELS[change.provider] ?? change.provider}` : ""}`
                    : "来源：模型"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p>没有需要写入的字段：空白已补齐或你手动改过的内容都保留原样。</p>
      )}
    </Dialog>
  );
}

/** 草稿 diff 正文的一行预览上限。 */
const DRAFT_DIFF_CHARS = 140;

function clampDraft(text: string): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > DRAFT_DIFF_CHARS ? `${chars.slice(0, DRAFT_DIFF_CHARS).join("")}…` : chars.join("");
}

/**
 * 笔记起草的逐块采纳（dialog="ai-note-preview"）：干跑起草后按块列出
 * 「现有内容 → AI 草稿」diff，默认只勾选空块；逐块接受或全部放弃。
 */
export function NotePreviewDialog() {
  const dialog = useField((s) => s.dialog);
  const notePreview = useField((s) => s.notePreview);
  const drafts = useField((s) => s.drafts);
  const dismissNotePreview = useField((s) => s.dismissNotePreview);
  const applyNotePreview = useField((s) => s.applyNotePreview);
  const open = dialog === "ai-note-preview" && Boolean(notePreview);
  const paperId = notePreview?.paperId ?? null;
  const [checked, setChecked] = useState<Set<NoteKind>>(new Set());
  const [busy, setBusy] = useState(false);

  // 打开 / 换预览时重置勾选：默认只采纳「现在是空块（也无草稿）」的块——空块被填不覆盖任何手写。
  useEffect(() => {
    if (!open || !notePreview) return;
    setBusy(false);
    setChecked(
      new Set(
        notePreview.kinds.filter((kind) => {
          const blockEmpty = !(notePreview.before[kind]?.content ?? "").trim();
          const draftEmpty = !(drafts[notePreview.paperId]?.[kind] ?? "").trim();
          return blockEmpty && draftEmpty && (notePreview.drafted[kind] ?? "").trim();
        }),
      ),
    );
  }, [open, notePreview, drafts]);

  if (!notePreview || !paperId) return null;
  const hasDraftDiff = notePreview.changes.length > 0;

  return (
    <Dialog
      open={open}
      title="草稿预览（逐块采纳）"
      onClose={dismissNotePreview}
      className="is-wide"
      footer={
        <>
          <Button type="button" onClick={dismissNotePreview}>
            全部放弃
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || !checked.size}
            onClick={() => {
              setBusy(true);
              void applyNotePreview([...checked]).finally(() => setBusy(false));
            }}
          >
            {busy ? "写入中…" : `采纳 ${checked.size} 块`}
          </Button>
        </>
      }
    >
      <p>
        《{notePreview.paperTitle}》· AI 已起草，还没有写库。逐块勾选要采纳的草稿；
        未勾选与起草期间你再改过的块都不会被写入。默认只勾选空块。
      </p>
      {hasDraftDiff ? (
        <ul className="ef-confirm-list ef-draft-list">
          {notePreview.kinds.map((kind) => {
            const change = notePreview.changes.find((item) => item.kind === kind);
            const current = drafts[paperId]?.[kind] ?? notePreview.before[kind]?.content ?? "";
            const drafted = notePreview.drafted[kind] ?? "";
            const changed = Boolean(change) && drafted.trim() && drafted !== current.trim();
            return (
              <li key={kind} className={current.trim() ? "is-manual" : ""}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked.has(kind)}
                    disabled={!changed}
                    onChange={(e) =>
                      setChecked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(kind);
                        else next.delete(kind);
                        return next;
                      })
                    }
                  />
                  <span className="ef-confirm-name">
                    {NOTE_LABELS[kind].zh}
                    <em className="ef-confirm-flag">{current.trim() ? "已有内容" : "空块"}</em>
                  </span>
                  <span className="ef-confirm-value ef-draft-diff">
                    {changed ? (
                      <>
                        <del>{clampDraft(current) || "（空白）"}</del>
                        <Icon name="right" />
                        <ins>{clampDraft(drafted)}</ins>
                      </>
                    ) : (
                      <span className="ef-draft-same">{drafted.trim() ? "草稿与当前内容相同" : "草稿为空"}</span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <p>这次起草没有产生变化，无需采纳。</p>
      )}
    </Dialog>
  );
}
