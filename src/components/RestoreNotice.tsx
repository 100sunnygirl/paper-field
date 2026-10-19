import { useEffect, useState, type ReactElement } from "react";
import type { RestoreStatus } from "../lib/engine";
import { isTauri } from "../lib/util";

async function call(cmd: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke(cmd);
}

async function relaunch(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

// 打开哪个目录由 Rust 侧按恢复状态决定，不从页面传路径（渲染进程没有「显示任意路径」的权限）。
const revealPre = () => call("reveal_pre_restore");

/** Startup restore outcome: stuck, rolled back, pending confirmation, restored. */
export function RestoreNotice({ initial }: { initial?: RestoreStatus }) {
  const [status, setStatus] = useState<RestoreStatus | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  useEffect(() => {
    if (initial || !isTauri()) return;
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      setStatus(await invoke<RestoreStatus>("restore_status"));
    })().catch(() => undefined);
  }, [initial]);

  if (!status || status.kind === "none") return null;

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setFailure("");
    try {
      await fn();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const abandon = run(async () => {
    await call("restore_abandon");
    await relaunch();
  });
  const apply = run(async () => {
    await call("restore_confirm_pending");
    await relaunch();
  });
  const dismiss = () => setStatus({ kind: "none" });

  let text = "";
  let actions: ReactElement[] = [];
  switch (status.kind) {
    case "stuck":
      text = `上一次恢复没有完成，文库暂不打开。原数据保存在：${status.pre || "应用数据目录"}`;
      actions = [
        <button key="abandon" disabled={busy} onClick={abandon}>放弃这次恢复</button>,
        ...(status.pre
          ? [<button key="reveal" disabled={busy} onClick={run(revealPre)}>打开原数据目录</button>]
          : []),
      ];
      break;
    case "pendingConfirm":
      text = "有一次恢复已准备好但还没应用。要现在应用吗？应用后会覆盖当前文库。";
      actions = [
        <button key="apply" disabled={busy} onClick={apply}>应用</button>,
        <button key="abandon" disabled={busy} onClick={abandon}>放弃</button>,
      ];
      break;
    case "rolledBack":
      text = `恢复中途失败，已退回到恢复前的文库。备份副本在：${status.pre}`;
      actions = [<button key="ok" onClick={dismiss}>知道了</button>];
      break;
    case "restored":
      text = status.summary
        ? `已恢复 ${status.summary.papers} 篇、${status.summary.pdfs} 个 PDF，原数据保存在 ${status.pre}。`
        : `已从备份恢复文库，原数据保存在 ${status.pre}。`;
      actions = [
        <button key="open" disabled={busy} onClick={run(revealPre)}>打开文件夹</button>,
        <button key="ok" onClick={dismiss}>知道了</button>,
      ];
      break;
  }

  return (
    <div role="alert" className="restore-notice" data-kind={status.kind}
      style={{ padding: "12px 16px", borderBottom: "1px solid currentColor", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <span>{text}</span>
      {status.kind === "restored" && status.summary?.settingsNotice ? <span>{status.summary.settingsNotice}</span> : null}
      {actions}
      {failure ? <span role="status">操作失败：{failure}</span> : null}
    </div>
  );
}
