import { useEffect, useState } from "react";
import { useField } from "../store";
import { Button, Dialog, Field } from "./ui";

export function PaperDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const createPaper = useField((s) => s.createPaper);
  const settings = useField((s) => s.settings);
  const [title, setTitle] = useState("");
  const [arxivId, setArxivId] = useState("");
  const [doi, setDoi] = useState("");
  const [pdfUrl, setPdfUrl] = useState("");
  const [runPrepare, setRunPrepare] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const open = dialog === "paper";

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setArxivId("");
    setDoi("");
    setPdfUrl("");
    setRunPrepare(true);
    setError(null);
  }, [open]);

  return (
    <Dialog
      open={open}
      kicker="Intake / new unit"
      title="+ Paper"
      onClose={closeDialog}
      footer={
        <>
          <Button type="button" onClick={closeDialog}>
            Cancel
          </Button>
          <Button
            primary
            type="button"
            onClick={() => {
              setError(null);
              void createPaper({
                title,
                arxivId,
                doi,
                pdfUrl,
                runPrepare: runPrepare && settings.hasKey,
              }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
            }}
          >
            COMMIT
          </Button>
        </>
      }
    >
      <p style={{ marginTop: 0, color: "var(--muted)" }}>至少填一项。有 Key 时会创建 prepareMeta 作业，但不会自动已读。</p>
      <Field light label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field light label="arXiv">
        <input value={arxivId} onChange={(e) => setArxivId(e.target.value)} placeholder="2304.08485" />
      </Field>
      <Field light label="DOI">
        <input value={doi} onChange={(e) => setDoi(e.target.value)} />
      </Field>
      <Field light label="PDF path / URL">
        <input value={pdfUrl} onChange={(e) => setPdfUrl(e.target.value)} />
      </Field>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
        <input
          type="checkbox"
          checked={runPrepare}
          onChange={(e) => setRunPrepare(e.target.checked)}
          disabled={!settings.hasKey}
        />
        入库后运行 LLM PREPARE {settings.hasKey ? "" : "（无 Key，已禁用）"}
      </label>
      {error ? <p style={{ color: "#a33" }}>{error}</p> : null}
    </Dialog>
  );
}

export function DomainDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const createDomain = useField((s) => s.createDomain);
  const updateDomain = useField((s) => s.updateDomain);
  const deleteDomain = useField((s) => s.deleteDomain);
  const domains = useField((s) => s.domains);
  const selectedDomainId = useField((s) => s.selectedDomainId);
  const current = domains.find((d) => d.id === selectedDomainId);
  const editing = dialog === "edit-domain";
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const open = dialog === "domain" || dialog === "edit-domain";

  useEffect(() => {
    if (!open) return;
    if (editing && current) {
      setName(current.name);
      setCode(current.code);
      setSummary(current.summary ?? "");
    } else if (!editing) {
      setName("");
      setCode("");
      setSummary("");
    }
    setError(null);
  }, [open, editing, selectedDomainId]);

  return (
    <Dialog
      open={open}
      kicker="Domain / field"
      title={editing ? "Edit field" : "+ Field"}
      onClose={closeDialog}
      footer={
        <>
          {editing ? (
            <Button type="button" onClick={() => void deleteDomain()}>
              DELETE
            </Button>
          ) : null}
          <Button type="button" onClick={closeDialog}>
            Cancel
          </Button>
          <Button
            primary
            type="button"
            onClick={() => {
              setError(null);
              const run = editing
                ? updateDomain({ name, code, summary })
                : createDomain({ name, code, summary });
              void run.catch((err: unknown) =>
                setError(err instanceof Error ? err.message : String(err)),
              );
            }}
          >
            COMMIT
          </Button>
        </>
      }
    >
      <Field light label="Name / 中文">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="多模态"
          autoFocus
        />
      </Field>
      <Field light label="Code">
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="MM-03" />
      </Field>
      <Field light label="Summary">
        <textarea value={summary} onChange={(e) => setSummary(e.target.value)} />
      </Field>
      {error ? <p style={{ color: "#a33" }}>{error}</p> : null}
    </Dialog>
  );
}

export function ConfirmNotesDialog() {
  const dialog = useField((s) => s.dialog);
  const closeDialog = useField((s) => s.closeDialog);
  const pendingDraftJob = useField((s) => s.pendingDraftJob);
  const runDraftNotes = useField((s) => s.runDraftNotes);

  return (
    <Dialog
      open={dialog === "confirm-notes"}
      kicker="Overwrite check"
      title="Notes touched"
      onClose={closeDialog}
      footer={
        <>
          <Button type="button" onClick={closeDialog}>
            Keep mine
          </Button>
          <Button
            primary
            type="button"
            onClick={() => void runDraftNotes(pendingDraftJob ?? undefined, true)}
          >
            Overwrite with LLM
          </Button>
        </>
      }
    >
      <p>你已经改过笔记。LLM 不会静默覆盖。确认后五块都会被 draftNotes 替换。</p>
    </Dialog>
  );
}
