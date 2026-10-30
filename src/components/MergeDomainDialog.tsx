import { useEffect, useState } from "react";
import { useField } from "../store";
import { Button, Dialog, Field } from "./ui";

type MergePreview = {
  fromName: string;
  intoName: string;
  fromCount: number;
  intoCount: number;
  duplicates: Array<{ title: string }>;
};

/**
 * 合并领域：来源域全部论文（含笔记、解析全文、作者关联）完整迁入目标域后删除来源域。
 * 提交前预览两边论文数与同名条目（同名论文不会自动去重，只提示由你确认）。
 */
export function MergeDomainDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const domains = useField((s) => s.domains);
  const selectedDomainId = useField((s) => s.selectedDomainId);
  const previewDomainMerge = useField((s) => s.previewDomainMerge);
  const mergeDomains = useField((s) => s.mergeDomains);
  const open = dialog === "merge-domain";
  const [fromId, setFromId] = useState("");
  const [intoId, setIntoId] = useState("");
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setFromId("");
      setIntoId("");
      setPreview(null);
      setBusy(false);
      setError(null);
      return;
    }
    // 默认来源=当前领域，目标=另一个领域（有得选时）。
    const other = domains.find((domain) => domain.id !== selectedDomainId);
    setFromId(selectedDomainId ?? "");
    setIntoId(other?.id ?? "");
  }, [open, domains, selectedDomainId]);

  useEffect(() => {
    if (!open || !fromId || !intoId || fromId === intoId) {
      setPreview(null);
      return;
    }
    let alive = true;
    previewDomainMerge(fromId, intoId)
      .then((result) => {
        if (alive) setPreview(result);
      })
      .catch(() => {
        if (alive) setPreview(null);
      });
    return () => {
      alive = false;
    };
  }, [open, fromId, intoId, previewDomainMerge]);

  const ready = Boolean(fromId && intoId && fromId !== intoId && !busy);

  return (
    <Dialog
      open={open}
      title="合并领域"
      onClose={closeDialog}
      className="is-wide"
      footer={
        <>
          <Button type="button" onClick={closeDialog}>
            取消
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!ready}
            onClick={() => {
              if (!ready) return;
              setError(null);
              setBusy(true);
              mergeDomains(fromId, intoId)
                .then(() => setBusy(false))
                .catch(() => setBusy(false));
            }}
          >
            {busy ? "合并中…" : "确认合并"}
          </Button>
        </>
      }
    >
      <p>
        把一个领域的全部论文（含笔记、解析全文与作者）完整并入另一个领域，然后删除来源领域。同名论文不会自动去重，预览里会列出来供你确认。
      </p>
      <div className="ef-merge-selects">
        <Field label="来源领域（合并后删除）">
          <select
            aria-label="来源领域"
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
          >
            <option value="">选择来源领域…</option>
            {domains.map((domain) => (
              <option key={domain.id} value={domain.id}>
                {domain.name}（{domain.code}）
              </option>
            ))}
          </select>
        </Field>
        <Field label="目标领域（保留）">
          <select
            aria-label="目标领域"
            value={intoId}
            onChange={(e) => setIntoId(e.target.value)}
          >
            <option value="">选择目标领域…</option>
            {domains
              .filter((domain) => domain.id !== fromId)
              .map((domain) => (
                <option key={domain.id} value={domain.id}>
                  {domain.name}（{domain.code}）
                </option>
              ))}
          </select>
        </Field>
      </div>
      {fromId && intoId && fromId === intoId ? (
        <p className="ef-error">来源与目标不能是同一个领域。</p>
      ) : null}
      {preview ? (
        <div className="ef-merge-preview">
          <p aria-live="polite">
            「{preview.fromName}」<strong>{preview.fromCount}</strong> 篇 → 「{preview.intoName}」（现,{" "}
            <strong>{preview.intoCount}</strong> 篇）
          </p>
          {preview.duplicates.length ? (
            <>
              <p className="ef-merge-dup-head">
                两边有 {preview.duplicates.length} 篇同名论文（合并后同名共存，可自行批量删除）：
              </p>
              <ul className="ef-merge-dups">
                {preview.duplicates.slice(0, 8).map((item) => (
                  <li key={item.title}>{item.title}</li>
                ))}
              </ul>
              {preview.duplicates.length > 8 ? (
                <p className="ef-field-hint">另有 {preview.duplicates.length - 8} 篇同名论文未逐条列出。</p>
              ) : null}
            </>
          ) : (
            <p className="ef-field-hint">两边没有同名论文。</p>
          )}
        </div>
      ) : fromId && intoId && fromId !== intoId ? (
        <p className="ef-field-hint">正在生成合并预览…</p>
      ) : null}
      {error ? <p className="ef-error">{error}</p> : null}
    </Dialog>
  );
}
