import { useEffect, useRef, useState } from "react";
import { useField } from "../store";

/**
 * 标已读的 +1 微反馈：store.readPulse 每次真正转入「已读」时 +1，
 * 这里把它变成约 700ms 的瞬时状态，供领域进度条与状态条计数挂动画类。
 * prefers-reduced-motion 由 workstation.css 的全局兜底接管（动画整体关闭）。
 */
export function useReadPulse(): boolean {
  const readPulse = useField((s) => s.readPulse);
  const [pulse, setPulse] = useState(false);
  const lastSeen = useRef(0);

  useEffect(() => {
    if (!readPulse || readPulse === lastSeen.current) return;
    lastSeen.current = readPulse;
    setPulse(true);
    const timer = window.setTimeout(() => setPulse(false), 700);
    return () => window.clearTimeout(timer);
  }, [readPulse]);

  return pulse;
}
