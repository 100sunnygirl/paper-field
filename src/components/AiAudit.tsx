import { useEffect, useMemo, useState } from "react";
import { latestAiWrite, noteVersions, type AiWriteRecord, type NoteVersion } from "../lib/aiAudit";
import { META_FIELD_LABELS, NOTE_DISPLAY_ORDER, NOTE_LABELS, type NoteKind } from "../lib/types";
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
