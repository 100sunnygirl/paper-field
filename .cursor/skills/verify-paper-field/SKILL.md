---
name: verify-paper-field
description: Paper Field browser-preview verification (reading workstation UI). Use after UI/store changes to prove user-visible behavior via Playwright; not a substitute for vitest/cargo unit tests.
---

# Verify Paper Field

Prove the reading workstation in the browser preview. `npm run dev` serves the React shell at `http://127.0.0.1:43173` with sql.js and IndexedDB. Playwright drives the Chinese UI. This does not replace `npm test` (vitest) or `cargo test`.

The desktop app (`npm run tauri dev`) is a different runtime. A green browser journey does not prove Tauri IPC, the system keychain, native PDF import, MinerU, or a real LLM.

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
| `all` | the five above |

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
