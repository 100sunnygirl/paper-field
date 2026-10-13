import "./fonts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { log } from "./lib/logger";
import { bindToastLog, type ToastLogEvent } from "./toasts";

// 通知 × 日志联动（评审裁定：toasts.notify 层是唯一收口，本处是产品侧唯一注入点）。
// 在模块加载时即绑定（早于 React 渲染），避免首个通知落在注入前的空窗期。
// 级别映射：emit 按通知级别 ok→info / warn→warn / error→error；
// dismiss / evict 记 info（发出与关闭都必须留痕）；refresh 是高频去重刷新，只记
// debug（缓冲留痕、不落盘），防止 guardUnsaved 类连续拦截刷爆日志。
function toastEventToLog(event: ToastLogEvent): void {
  if (event.action === "emit") {
    if (event.tone === "error") log.error("ui", event.text);
    else if (event.tone === "warn") log.warn("ui", event.text);
    else log.info("ui", event.text);
    return;
  }
  if (event.action === "refresh") {
    log.debug("ui", `通知刷新停留计时：${event.text}`);
    return;
  }
  if (event.action === "evict") {
    log.info("ui", `通知超出堆叠上限被逐出：${event.text}`);
    return;
  }
  const how = event.reason === "auto" ? "自动消退" : "手动关闭";
  log.info("ui", `通知关闭（${how}）：${event.text}`);
}

bindToastLog(toastEventToLog);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
