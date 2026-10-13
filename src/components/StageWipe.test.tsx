// 模式切换的接线契约：产品侧在 App.tsx 以 mode+domain 为 key 重挂舞台三面，
// 动效侧不再用整页 pf-wipe / pf-scan 或标题 pf-text-in 把内容藏到第一帧之后。
// jsdom 不播 CSS 动画，故沿用「源码 + CSS 口径」断言。不回退点：
//   1. 舞台三面都挂由 stageKey 派生、且互不相同的 key；
//   2. 模式切换最多 150ms 透明度过渡，起点仍可读，不用 clip-path 刷出；
//   3. 标题保持 --pf-ink，不播色块揭幕；
//   4. prefers-reduced-motion 仍关掉壳内动画；像素消融不得回潮。
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

describe("舞台切换：动效不遮住内容（CSS 口径）", () => {
  it("模式切换不用整页刷出，只保留 150ms 且起点可读的透明度过渡", () => {
    expect(css).not.toContain("pf-wipe");
    expect(css).not.toContain("pf-scan");
    expect(css).toContain("--pf-t-mode: 150ms var(--pf-ease-out)");
    const frames = css.match(/@keyframes pf-mode-fade \{[\s\S]*?\n\}/)![0];
    expect(frames).toContain("opacity: 0.88");
    expect(frames).not.toContain("opacity: 0;");
    expect(frames).not.toContain("clip-path");
    expect(css).toMatch(
      /\.ef-shell \.ef-nav,\n\.ef-shell \.ef-read,\n\.ef-shell \.ef-system \{\n  animation: pf-mode-fade var\(--pf-t-mode\) both;\n\}/,
    );
  });

  it("标题不再色块揭幕，样式里直接是墨色", () => {
    expect(css).not.toContain("pf-text-in");
    expect(css).not.toContain("pf-block-reveal");
    expect(css).toMatch(/\.ef-read-title \{[^}]*color: var\(--pf-ink\);/);
  });

  it("reduced-motion 仍然关掉壳内动画", () => {
    expect(css).toMatch(/\.ef-shell,\n  \.ef-shell \*,/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toContain("animation: none !important");
  });
});
