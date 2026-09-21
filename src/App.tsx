import { useEffect, useState } from "react";
import { isTauri } from "./lib/util";
import { ConfirmNotesDialog, DomainDialog, PaperDialog } from "./components/Dialogs";
import { ReadingStage } from "./components/Dossier";
import { PaperNav } from "./components/FieldView";
import { Dock, Rail, StatusStrip } from "./components/Shell";
import { SystemView } from "./components/SystemView";
import { useField } from "./store";
import "./styles/workstation.css";

export default function App() {
  const init = useField((s) => s.init);
  const ready = useField((s) => s.ready);
  const error = useField((s) => s.error);
  const mode = useField((s) => s.mode);
  const domains = useField((s) => s.domains);
  const selectedDomainId = useField((s) => s.selectedDomainId);
  const search = useField((s) => s.search);
  const flash = useField((s) => s.flash);
  const setFlash = useField((s) => s.setFlash);
  const paper = useField((s) => s.paper);
  const navigatePapers = useField((s) => s.navigatePapers);
  const openDialog = useField((s) => s.openDialog);
  const closeDialog = useField((s) => s.closeDialog);
  const markRead = useField((s) => s.markRead);
  const dialog = useField((s) => s.dialog);
  const setMode = useField((s) => s.setMode);
  const [wiped, setWiped] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 4200);
    return () => window.clearTimeout(t);
  }, [flash, setFlash]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
      if (event.key === "Escape") {
        closeDialog();
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "n") {
        event.preventDefault();
        openDialog("paper");
        return;
      }
      if (meta && event.key.toLowerCase() === "r") {
        event.preventDefault();
        void markRead();
        return;
      }
      if (typing || dialog) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        void navigatePapers(1);
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        void navigatePapers(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDialog, dialog, markRead, navigatePapers, openDialog]);

  useEffect(() => {
    if (!ready) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) setWiped(true);
  }, [ready]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen<string>("menu://action", (event) => {
        const id = event.payload;
        if (id === "new-paper") openDialog("paper");
        if (id === "new-domain") openDialog("domain");
        if (id === "mark-read") void markRead();
        if (id === "mode-field") void setMode("field");
        if (id === "mode-archive") void setMode("archive");
        if (id === "mode-intake") void setMode("intake");
        if (id === "mode-system") void setMode("system");
      }).then((fn) => {
        unlisten = fn;
      });
    });
    return () => unlisten?.();
  }, [markRead, openDialog, setMode]);

  const domain = domains.find((d) => d.id === selectedDomainId) ?? null;
  const domainIndex = Math.max(1, domains.findIndex((d) => d.id === selectedDomainId) + 1);

  if (!ready) {
    return (
      <div className="loading-cal" role="status">
        <div className="bar" aria-label="Calibrating">
          <i />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty" style={{ padding: 48 }}>
        <h2>Storage fault</h2>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div
      className="ef-shell"
      data-mode={mode}
      data-has-paper={paper && mode !== "system" ? "true" : "false"}
    >
      {!wiped ? <div className="ef-wipe" onAnimationEnd={() => setWiped(true)} /> : null}
      <Rail
        mode={mode}
        domains={domains}
        selectedDomainId={selectedDomainId}
        domainIndex={domainIndex}
      />
      <Dock domain={domain} search={search} />
      {mode === "system" ? (
        <SystemView />
      ) : (
        <>
          <PaperNav />
          <ReadingStage />
        </>
      )}
      <StatusStrip />
      {flash ? <div className={`ef-flash ${flash.tone}`}>{flash.text}</div> : null}
      <PaperDialog />
      <DomainDialog />
      <ConfirmNotesDialog />
    </div>
  );
}
