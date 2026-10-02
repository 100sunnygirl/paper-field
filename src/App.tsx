import { useEffect, useState } from "react";
import { isTauri } from "./lib/util";
import {
  ConfirmMetaDialog,
  ConfirmNotesDialog,
  DeletePaperDialog,
  DomainDialog,
  DomainPickerDialog,
  EditPaperDialog,
  PaperDialog,
} from "./components/Dialogs";
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
  const [focus, setFocus] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 4200);
    return () => window.clearTimeout(t);
  }, [flash, setFlash]);

  useEffect(() => {
    setListOpen(false);
    setContextOpen(false);
    if (mode === "system") setFocus(false);
  }, [mode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
      if (event.key === "Escape") {
        closeDialog();
        setListOpen(false);
        setContextOpen(false);
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const input = document.getElementById("global-search") as HTMLInputElement | null;
        if (input && getComputedStyle(input).display !== "none") {
          input.focus();
          return;
        }
        if (mode === "system") {
          // 设置模式不渲染搜索框：先切回阅读模式，再等 React 提交 Dock 后聚焦。
          // setMode 是异步 zustand 更新，单帧 rAF 可能在 #global-search 挂载前触发，
          // 因此用双 rAF；第二帧仍取不到时静默返回。
          void setMode("field").finally(() => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const el = document.getElementById("global-search") as HTMLInputElement | null;
                if (el && getComputedStyle(el).display !== "none") el.focus();
              });
            });
          });
          return;
        }
        setListOpen(true);
        return;
      }
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
  }, [closeDialog, dialog, markRead, mode, navigatePapers, openDialog, setMode]);

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

  if (!ready) {
    return (
      <div className="loading-cal" role="status">
        <div className="bar" aria-label="正在打开阅读工作台">
          <i />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty" style={{ padding: 48 }}>
        <h2>存储无法打开</h2>
        <p>{error}</p>
      </div>
    );
  }

  const shellClass = [
    "ef-shell",
    focus ? "is-focus" : "",
    listOpen ? "is-list-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={shellClass}
      data-mode={mode}
      data-has-paper={paper && mode !== "system" ? "true" : "false"}
    >
      <Rail mode={mode} />
      <Dock domain={domain} search={search} />
      {mode === "system" ? (
        <SystemView />
      ) : (
        <>
          <PaperNav onPaperChosen={() => setListOpen(false)} />
          <ReadingStage
            focus={focus}
            onToggleFocus={() => setFocus((value) => !value)}
            listOpen={listOpen}
            onToggleList={() => setListOpen((value) => !value)}
            contextOpen={contextOpen}
            onToggleContext={() => setContextOpen((value) => !value)}
          />
        </>
      )}
      <StatusStrip />
      {flash ? <div className={`ef-flash ${flash.tone}`}>{flash.text}</div> : null}
      <PaperDialog />
      <DomainDialog />
      <DomainPickerDialog />
      <DeletePaperDialog />
      <EditPaperDialog />
      <ConfirmNotesDialog />
      <ConfirmMetaDialog />
    </div>
  );
}
