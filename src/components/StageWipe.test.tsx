// 舞台刷出（pf-wipe，源设计 bjtu-hpc-submit-skill 登录页 ef-reveal）的接线契约：
// 产品侧在 App.tsx 以 mode+domain 为 key 重挂舞台三面触发重播，动效侧在
// workstation.css 以令牌 + keyframes 落地。jsdom 不播 CSS 动画，故沿用
// Toasts.audit 的「源码 + CSS 口径」断言先例（Toasts.audit.test.tsx 同款读法），
// 固定以下不回退点：
//   1. 舞台三面（PaperNav / ReadingStage / SystemView）都挂由 stageKey 派生的 key
//      —— 缺一个就有切换路径不重播（最易漏的是 field↔archive：树位置不变，无 key
//      不重挂）；且三者互不相同：PaperNav 与 ReadingStage 同处一个 Fragment，
//      重复 key 会让 React 残留旧节点（旧 .ef-nav 逐次堆积、遮挡点击）；
//   2. keyframes 只用 clip-path + 位移（无 opacity / 无随机），fill 只 backwards
//      —— 结束后 clip 不残留，浮层与阴影不受长期裁剪；
//   3. 动画挂在 .ef-shell 伞内的三个根类上，reduced-motion 兜底按构造覆盖；
//   4. 时长 / 缓动 / 位移全部走令牌，消费点无裸值；像素消融（.ef-dissolve）
//      已整体移除，不得回潮。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appSource = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
// Git may check CSS out with CRLF on Windows; normalize source before regex contracts.
const css = readFileSync(resolve(__dirname, "../styles/workstation.css"), "utf8").replace(/\r\n/g, "\n");

describe("舞台刷出：App 接线（源码口径）", () => {
  it("stageKey 由 mode + selectedDomainId 组成，三面舞台各挂一个由它派生、互不相同的 key", () => {
    expect(appSource).toContain('const stageKey = `${mode}:${selectedDomainId ?? "none"}`');
    // 三处消费：SystemView / PaperNav / ReadingStage
    const keys = appSource.match(/key=\{`\w+:\$\{stageKey\}`\}/g) ?? [];
    expect(keys).toHaveLength(3);
    // 同一 Fragment 内的兄弟节点 key 必须唯一，否则切换时旧节点残留。
    expect(new Set(keys).size).toBe(3);
    expect(appSource).not.toMatch(/key=\{stageKey\}/);
  });

  it("不再有像素消融的滞后提交机制（display 快照 / DissolveVeil 已移除）", () => {
    expect(appSource).not.toContain("DissolveVeil");
    expect(appSource).not.toContain("setDisplay");
    expect(css).not.toContain(".ef-dissolve");
  });
});

describe("舞台刷出：动效契约（CSS 口径）", () => {
  it("令牌齐备：复合时长令牌（含源设计缓动）与位移令牌", () => {
    expect(css).toContain("--pf-t-wipe: 650ms cubic-bezier(0.22, 0.8, 0.2, 1)");
    expect(css).toContain("--pf-wipe-shift: 10px");
  });

  it("keyframes 只用 clip-path 硬边 + 位移回位，无 opacity", () => {
    const frames = css.match(/@keyframes pf-wipe \{[\s\S]*?\n\}/)![0];
    expect(frames).toContain("clip-path: inset(0 100% 0 0)");
    expect(frames).toContain("clip-path: inset(0)");
    expect(frames).toContain("translateX(calc(var(--pf-wipe-shift) * -1))");
    expect(frames).not.toContain("opacity");
  });

  it("动画挂 .ef-shell 伞内三面根类，fill 只 backwards（clip 不残留）", () => {
    const attachments = css.match(
      /\.ef-shell \.ef-nav,\n\.ef-shell \.ef-read,\n\.ef-shell \.ef-system \{\n  animation: pf-wipe var\(--pf-t-wipe\) backwards;\n\}/,
    );
    expect(attachments).not.toBeNull();
    // 伞作用域保证 reduced-motion 兜底覆盖（.ef-shell * → animation: none）。
    expect(css).toMatch(/\.ef-shell,\n  \.ef-shell \*,/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
