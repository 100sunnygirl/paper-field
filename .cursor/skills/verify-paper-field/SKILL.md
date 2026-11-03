---
name: verify-paper-field
description: Paper Field browser-preview verification (reading workstation UI). Use after UI/store changes to prove user-visible behavior via Playwright; not a substitute for vitest/cargo unit tests.
---

# Verify Paper Field

Prove the reading workstation in the browser preview. `npm run dev` serves the React shell at `http://127.0.0.1:43173` with sql.js and IndexedDB. Playwright drives the Chinese UI. This does not replace `npm test` (vitest) or `cargo test`.

The desktop app (`npm run tauri dev`) is a different runtime. A green browser journey does not prove Tauri IPC, the system keychain, native PDF import, MinerU, or a real LLM.

## Sync

The skill did not record a sync commit before this section. On main, the verification files last changed in `95c7c0ad40977ee2ed0a36b765f26a9343ea4a26` (squash of the skill; the tree matches `5e7c25e`, which is not an ancestor of main). The commit these checks were run against, and the sync commit, is `1a573f32c5c99283994f514ae09093d83accea61`.

No commit in that range changes a behavior the journeys describe. The only frontend file in the range is `src/components/Dialogs.test.tsx`, and it only waits for a folder scan. The browser journey never clicks 选择文件夹. `src/components/Dialogs.tsx` is unchanged. Rust edits are gated on `desktop-e2e` (profile path, log path, test PDF picker) or are new tests of the existing LLM and MinerU HTTP clients, including `api_base` and `extract_batch_url` in `src-tauri/src/mineru_api.rs`. `npm run dev` still serves this same React shell. Vite, React, and sql.js stay on 8.3.4, 19.3.1, and 1.15.0.

| Check | Property | Code | Bounds |
|---|---|---|---|
| `reading-shell` | Rail 阅读 / 归档 / 入库 / 设置, footer 已读 1 / 3, 队列空闲, 尚未配置 AI 服务, MinerU 未配置, seed list, 归档 excludes 在读, 入库 excludes 已读 | `Shell.tsx`, `FieldView.tsx`, `App.tsx`, `seed.ts`, `vite.config.ts` port 43173, `workstation.css` at 1400px and 1100px | Viewport 1600×1000. Fresh context so IndexedDB `paper-field` is empty and the seed loads. |
| `paper-list-and-notes` | Search CLIP, open 从自然语言监督中学习可迁移视觉模型, 写总结, 保存笔记, source 手动笔记 | `PaperSearch.tsx`, `Dossier.tsx` `NoteEditor`, `seed.ts` empty CLIP notes | Same viewport and fresh context. Do not click the LLaVA row; its abstract also matches CLIP. |
| `add-paper-manual` | Dialog says 浏览器预览不能读取本机 PDF, 创建论文 keeps the typed title | `Dialogs.tsx` `ManualPaperForm`, `store.ts` `createManualPaper` | No arXiv id and no DOI. Title is user-owned, so a quiet bibliography lookup must not replace it. |
| `mark-reading-status` | 修改阅读状态 moves the CLIP paper from 在读 to 已读, footer becomes 已读 2 / 3, 归档 lists it | `Dossier.tsx` reading-status `<select>`, `store.ts` `setReadingStatus`, archive list in `FieldView.tsx` | Context rail is visible only at ≥1400px. The journey does not open the 资料 drawer. |
| `system-settings` | Headings AI 服务设置, 数据导出, 备份与恢复, 快捷键, MinerU 解析源, 文献库; regions 本地 CLI, SSH 远程, 官方 API; saving 联系邮箱 shows 已配置 for Crossref | `SystemView.tsx`, `biblio.ts` browser `localStorage` path | Do not click 测试连接, 检查更新, 备份, or 恢复. |

Command, from the repo root: `scripts/drive-smoke.sh <check>` or `scripts/drive-smoke.sh all`. `all` runs the five checks in the table order, one new browser context each. Exit 0 is a pass, exit 1 is an assertion or page error, exit 2 is a missing tool, an unknown check, or a foreign process on 43173.

These checks still do not cover code that landed after `95c7c0a`:

- `tests/desktop/smoke.spec.mjs` opens the real Tauri window, imports a PDF, saves 总结, and reopens the same SQLite profile. A green browser journey does not prove that restart.
- `src-tauri/src/llm.rs` contract tests and `src-tauri/src/mineru_api.rs` upload, poll, and zip download. Browser preview never calls those clients.
- The native file picker, the system keychain, and a live MinerU or LLM call.

## Launch

From the repo root, after `npm ci`:

```bash
.cursor/skills/verify-paper-field/scripts/launch.sh
```

- Binds only `127.0.0.1:43173` (`vite.config.ts`, `strictPort`).
- Writes the session leader to `evidence/dev-server.pid` and the log to `evidence/dev-server.log`.
- Exit 0: this invocation started the server (`started pid …`).
- Exit 10: this skill already owns the port (`already-running pid …`). Safe to drive.
- Exit 2: something else is listening. The script prints the foreign pid and stops. It does not kill that process and it does not start a second server.

## Doctor

```bash
.cursor/skills/verify-paper-field/scripts/doctor.sh
```

Checks Node 20+, `node_modules`, the Playwright install under `~/.cache/pf-verify-tools`, a Chromium binary, whether port 43173 is free / ours / foreign, and that `evidence/` is writable. Exit 0 means a drive can start. Exit 1 names the missing piece.

## Drive

```bash
.cursor/skills/verify-paper-field/scripts/drive-smoke.sh reading-shell
.cursor/skills/verify-paper-field/scripts/drive-smoke.sh all
```

`drive-smoke.sh` launches (or reuses our server), runs `drive.mjs`, and on the way out stops a server that this invocation started. A server that was already ours (exit 10) is left running.

Journeys, each in a new browser context so the seed data loads again:

| Argument | What it proves |
|---|---|
| `reading-shell` | 阅读 / 归档 / 入库 / 设置, status strip, seeded 多模态 list |
| `paper-list-and-notes` | 搜索论文 for CLIP, open the paper, 写总结, 保存笔记 |
| `add-paper-manual` | 添加论文 dialog, browser PDF refusal, 创建论文 |
| `mark-reading-status` | 修改阅读状态 from 在读 to 已读, then the paper appears under 归档 |
| `system-settings` | 设置 sections, MinerU source cards, save 联系邮箱 |
| `reading-holds` | filename claim, unchanged note save, create-domain move, Ctrl R undo, note checklist, desktop-only restore |
| `all` | the six above |

Exit 0 when every requested journey passes. Exit 1 on an assertion or page error. Exit 2 when Playwright is missing or the journey name is unknown. The report is `evidence/drive-report.json`.

Viewport is 1600×1000. Below 1400px the 资料 rail (including 修改阅读状态) is hidden. Below 1100px the paper list becomes a drawer.

## Evidence

Screenshots and logs go to `.cursor/skills/verify-paper-field/evidence/`. That directory ignores everything except `.gitignore`. Do not commit png, logs, or the pidfile.

A passing journey writes `evidence/<journey>.png`. A failure writes `evidence/<journey>-failed.png` plus the error in `drive-report.json`.

## Cleanup

```bash
.cursor/skills/verify-paper-field/scripts/cleanup.sh
```

Signals the process group recorded in the pidfile. It refuses to signal a pid whose `/proc/<pid>/cwd` is not this checkout, and it does not touch a foreign listener on 43173.

## Helpers

`scripts/_env.sh` is sourced by the shell scripts. It exports `PF_ROOT`, `PF_URL` (`http://127.0.0.1:43173`), `PF_TOOLS` (`~/.cache/pf-verify-tools`), `PF_BROWSERS`, `PF_EVIDENCE`, and `PLAYWRIGHT_BROWSERS_PATH`. Override the tools directory with `PF_VERIFY_TOOLS`.

Install browsers once, outside the repo (does not edit `package.json`):

```bash
.cursor/skills/verify-paper-field/scripts/setup-tools.sh
```

`scripts/drive.mjs` helpers, used by every journey:

- `openWorkstation(page)` waits for 主导航 and the seeded 论文列表 (or throws the 存储无法打开 text).
- `clickMode(page, label)` clicks 阅读 / 归档 / 入库 / 设置 in 主导航.
- `paperList(page)` is the 论文列表 listbox. `statusStrip(page)` is `footer.ef-status`.
- `shot(page, name)` writes `evidence/<name>.png`.

Feature contracts (labels, how a person gets there, selectors, gotchas) live in `features/`. Read the feature file before changing a journey.
