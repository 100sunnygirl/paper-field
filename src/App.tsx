import { useEffect, useState } from "react";
import { isTauri } from "./lib/util";
import {
  ConfirmMetaDialog,
  ConfirmNotesDialog,
  DeleteCheckedPapersDialog,
  DeletePaperDialog,
  DomainDialog,
  DomainPickerDialog,
  EditPaperDialog,
  PaperDialog,
} from "./components/Dialogs";
import { ReadingStage } from "./components/Dossier";
import { PaperNav } from "./components/FieldView";
import { JobsPanel } from "./components/JobsPanel";
import { Dock, Rail, StatusStrip } from "./components/Shell";
import { SystemView } from "./components/SystemView";
import { Toasts } from "./components/Toasts";
import { MigrationNotices } from "./components/MigrationNotices";
import { RestoreNotice } from "./components/RestoreNotice";
import { useField } from "./store";

function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable || Boolean(target.closest("[contenteditable]"));
}

/** 聚焦论文列表栏里的搜索框；它或任一祖先被 display:none 隐藏时不动，返回 false。 */
function focusSearch(): boolean {
  const input = document.getElementById("global-search") as HTMLInputElement | null;
  if (!input) return false;
  for (let node: HTMLElement | null = input; node; node = node.parentElement) {
    if (getComputedStyle(node).display === "none") return false;
  }
  input.focus();
  input.select();
  return true;
}

/**
 * ⌘R / Ctrl+R and the mark-read menu. Typing, an open dialog, the settings page, or no
 * visible paper leaves the paper alone. The key's default (webview reload on Windows)
 * is always suppressed: a reload would drop unsaved work and orphan running jobs.
 */
export function requestMarkRead(event?: { preventDefault: () => void; target: EventTarget | null }) {
  event?.preventDefault();
  const target = event?.target ?? (typeof document !== "undefined" ? document.activeElement : null);
  const state = useField.getState();
  if (typingTarget(target) || state.dialog || state.mode === "system") return;
  const paperId = state.paper?.id ?? state.selectedPaperId;
  if (!paperId) return;
  void state.markRead(paperId);
}
import { setPersistFailureHandler } from "./lib/engine";
import { notify } from "./toasts";
import "./styles/workstation.css";

export default function App() {
  const init = useField((s) => s.init);
  const ready = useField((s) => s.ready);
  const error = useField((s) => s.error);
  const mode = useField((s) => s.mode);
  const selectedDomainId = useField((s) => s.selectedDomainId);
  const paper = useField((s) => s.paper);
  const navigatePapers = useField((s) => s.navigatePapers);
  const openDialog = useField((s) => s.openDialog);
  const closeDialog = useField((s) => s.closeDialog);
  const dialog = useField((s) => s.dialog);
  const setMode = useField((s) => s.setMode);
  const setJobsOpen = useField((s) => s.setJobsOpen);
  const [focus, setFocus] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);

  useEffect(() => {
    // engine 的 SQLite 落盘失败改走 toast 通知（经 notify 收口自动入运行日志），
    // 卸载时摘除 handler、恢复 engine 内的 console.error 兜底（单出口互斥）。
    setPersistFailureHandler((message) => notify("error", message));
    return () => setPersistFailureHandler(null);
  }, []);

  useEffect(() => {
    void init();
  }, [init]);

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
        setJobsOpen(false);
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "j") {
        // 作业面板是非模态浮层：对话框打开时不叠出来，避免焦点在两层之间来回跳。
        event.preventDefault();
        if (!dialog) setJobsOpen(!useField.getState().jobsOpen);
        return;
      }
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (focusSearch()) return;
        // 搜索框在论文列表栏里：设置页不渲染列表栏，专注模式隐藏它，窄屏它是抽屉。
        // 先把列表栏亮出来，再等 React 提交后聚焦。setMode 是异步 zustand 更新，
        // 单帧 rAF 可能在 #global-search 挂载前触发，因此用双 rAF；仍取不到时静默返回。
        const later = () => requestAnimationFrame(() => requestAnimationFrame(() => void focusSearch()));
        if (mode === "system") {
          void setMode("field").finally(later);
          return;
        }
        setFocus(false);
        setListOpen(true);
        later();
        return;
      }
      if (meta && event.key.toLowerCase() === "n") {
        event.preventDefault();
        // 不替换已经打开的对话框（编辑中的论文信息会被直接丢掉）。
        if (!dialog) openDialog("paper");
        return;
      }
      if (meta && event.key.toLowerCase() === "r") {
        requestMarkRead(event);
        return;
      }
      // 设置页没有论文列表，资料抽屉打开时也不在背后切换论文：方向键交还给页面滚动。
      if (typing || dialog || mode === "system" || contextOpen) return;
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
  }, [closeDialog, contextOpen, dialog, mode, navigatePapers, openDialog, setJobsOpen, setMode]);

  useEffect(() => {
    if (!isTauri()) return;
    // listen 是异步注册：清理先于注册完成时（StrictMode 的二次挂载）要在完成后立即注销，
    // 否则会留下一个永远不移除的监听器，菜单动作触发两次。
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen<string>("menu://action", (event) => {
        const id = event.payload;
        const busy = Boolean(useField.getState().dialog);
        if (id === "new-paper" && !busy) openDialog("paper");
        if (id === "new-domain" && !busy) openDialog("domain");
        if (id === "mark-read") requestMarkRead();
        if (id === "mode-field") void setMode("field");
        if (id === "mode-archive") void setMode("archive");
        if (id === "mode-intake") void setMode("intake");
        if (id === "mode-system") void setMode("system");
      }).then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openDialog, setMode]);

  // 舞台三面以 mode+domain 为 key 重挂，模式/领域切换时重播不超过 150ms 的透明度过渡。
  // 外壳（rail/dock/status）不挂动画。三面各带前缀派生自己的 key：PaperNav 与
  // ReadingStage 是同一 Fragment 内的兄弟节点，共用同一个 key 会让 React 在切换时
  // 残留旧节点（旧 .ef-nav 叠层堆积、遮挡点击）。
  const stageKey = `${mode}:${selectedDomainId ?? "none"}`;

  if (!ready) {
    return (
      <div className="loading-cal" role="status">
        <div className="loading-brand" aria-hidden="true">
          <span className="ef-mark" />
          <strong>PAPER FIELD</strong>
        </div>
        <div className="bar" aria-label="正在打开阅读工作台">
          <i />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty" style={{ padding: 48 }}>
        <RestoreNotice />
        <MigrationNotices />
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
      <RestoreNotice />
      <MigrationNotices />
      <Rail mode={mode} />
      <Dock />
      {mode === "system" ? (
        <SystemView key={`system:${stageKey}`} />
      ) : (
        <>
          <PaperNav key={`nav:${stageKey}`} onPaperChosen={() => setListOpen(false)} />
          <ReadingStage
            key={`read:${stageKey}`}
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
      {/* 作业面板：从状态条「作业」入口上拉的非模态浮层，层级低于对话框、高于列表抽屉。 */}
      <JobsPanel />
      <PaperDialog />
      <DomainDialog />
      <DomainPickerDialog />
      <DeletePaperDialog />
      <DeleteCheckedPapersDialog />
      <EditPaperDialog />
      <ConfirmNotesDialog />
      <ConfirmMetaDialog />
      {/* 通知弹窗：右上角堆叠、各自自动消失（错误类停留更久）、可手动关闭；
          挂在各 Dialog 之后，层叠由 z-index 变量控制（toast 120 > dialog 30）。 */}
      <Toasts />
    </div>
  );
}
