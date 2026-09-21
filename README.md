# Paper Field / 论文现场

Local-first research-paper notes for macOS. Organize papers by research domain, let an optional LLM fill structured metadata, then write notes in your own voice and mark read yourself.

按研究领域组织的论文笔记台：入库时可用 LLM 预填基础信息，阅读后由你补全洞察并**手动**标记已读。LLM 永远不会把论文标成已读。

## Reading-workstation UI pass / 阅读工作台改版

The product chrome is a **reading workstation**: charcoal top bar, pale mode rail, paper list, document stage, and a quiet context rail. Signal yellow (`#FFFA00`) is reserved for **打开 PDF** and small selection cues — not every button. Body text uses `#30332F` on canvas `#F2F2F0` / surface `#FFFFFF`, with muted `#686B64`. UI type is a single stack (`Inter / Noto Sans SC / PingFang SC`); monospace is only for indices and identifiers.

产品界面是阅读工作台：炭黑顶栏、浅色模式轨、论文列表、正文舞台和安静的资料栏。信号黄只用于「打开 PDF」和少量选中提示。现场笔记顺序为总结 → 亮点 → 不足 → 启示 → 备注。

## Phase 1 scope

- Domain CRUD and paper CRUD (title, Chinese title, abstract, year, venue, DOI, arXiv, ordered authors with affiliation/lab, labs, PDF/code/project URLs, `codeOpenSource`, tags)
- Note blocks in Markdown: remarks / summary / highlights / weaknesses / implications, each with `manual|llm` source and user-edited flag
- Reading status `unread | reading | read` — **only the user** can mark read
- Add-paper flow: title and/or arXiv/DOI/PDF path → create in domain → optional `prepareMeta` → optional `draftNotes`
- User-supplied OpenAI-compatible API key (base URL + model + key). Real cancelable HTTP jobs. No key: full manual entry still works
- **Reading-first IA:** the selected paper’s title, abstract, and **现场笔记** (总结 / 亮点 / 不足 / 启示 / 备注) live on a white document stage. Authors, DOI, links, reading status, TOC, and AI actions sit in the context rail. **打开 PDF** is the page primary. LLM never auto-marks read.
- Modes: 现场 / 归档 / 入库 / 系统 — ARCHIVE and INTAKE keep the same navigator + stage shell; SYSTEM uses the remaining width
- Status strip with real counts (read x/y, open-source, LLM queue) — no design-contract chrome
- Search and Markdown export of a domain
- Keyboard: ↑↓ list, ⌘N 添加论文, ⌘R 标记已读, ⌘K 搜索
- Move paper across domains via 更多 → 移动到其他领域; delete requires a confirm dialog

## Run on macOS

Prerequisites:

1. **macOS 15+**
2. **Xcode Command Line Tools**: `xcode-select --install`
3. **Rust 1.85+** via [rustup](https://rustup.rs) (`rustup default stable`)
4. **Node.js 20+** (npm)

```bash
git clone <this-repo>
cd paper-field
npm install
npm run tauri dev
```

The desktop window is the real app (`npm run tauri dev`). SQLite lives in the app data directory; the API key is stored in the app config directory (`llm-settings.json`) and mirrored into `tauri-plugin-store`. The key is never echoed back to the UI after save.

To ship a `.app` / `.dmg`:

```bash
npm run tauri build
```

### UI-only preview (browser)

`npm run dev` serves the React shell at `http://127.0.0.1:43173` with a sql.js + IndexedDB fallback. Use this when you are not on macOS or do not have the Tauri webview stack. Browser LLM calls may fail CORS; the desktop app proxies completions in Rust.

```bash
npm install
npm run dev
```

## Set API key

1. Open **系统**
2. Set an OpenAI-compatible **Base URL** (default `https://api.openai.com/v1`) and **model**
3. Paste the key → **保存设置**
4. Status strip shows `AI 已配置`
5. On a paper, run **补全论文信息** then optionally **起草阅读笔记**
6. When you are done reading, set **已读** in the context rail (⌘R)

Without a key, add papers and edit every field by hand. Sample domains (多模态 / 指令对齐) and three papers load automatically on first launch.



## 从源码安装（macOS）/ Install from source

前置：macOS 15+、Xcode CLT（`xcode-select --install`）、Rust（[rustup](https://rustup.rs)，1.85+）、Node.js 20+。

```bash
git clone https://github.com/100sunnygirl/paper-field.git
cd paper-field
npm install

# 开发运行（桌面窗口）
npm run tauri dev

# 打可双击的 .app / .dmg
npm run tauri build
```

安装到「应用程序」：

```bash
APP="src-tauri/target/release/bundle/macos/Paper Field.app"
rm -rf "/Applications/Paper Field.app"
cp -R "$APP" "/Applications/Paper Field.app"
xattr -dr com.apple.quarantine "/Applications/Paper Field.app"
open "/Applications/Paper Field.app"
```

首次 release 编译会较久；之后增量会快很多。

## 更新代码后如何更新软件 / Update after pulling

本地笔记数据在应用数据目录，**不在** `.app` 包内，替换应用一般不会丢数据：

- SQLite：`~/Library/Application Support/com.paperfield.app/paper-field.db`
- API Key 等：同目录下的 `llm-settings.json`（及 store）

更新步骤：

```bash
cd paper-field
git pull
npm install
npm run tauri build

APP="src-tauri/target/release/bundle/macos/Paper Field.app"
rm -rf "/Applications/Paper Field.app"
cp -R "$APP" "/Applications/Paper Field.app"
xattr -dr com.apple.quarantine "/Applications/Paper Field.app"
```

若只想验证 UI、暂不重打包，可先 `npm run tauri dev`。

浏览器预览（非桌面）：`npm run dev` → `http://127.0.0.1:43173`（LLM 可能遇 CORS，完整能力以桌面为准）。

## Keyboard

| Shortcut | Action |
|---|---|
| ↑ / ↓ | Move in the current paper list |
| ⌘N / Ctrl+N | 添加论文 |
| ⌘R / Ctrl+R | 标记已读 |
| ⌘K / Ctrl+K | 搜索 |
| Esc | Close dialog / 关闭抽屉 |

## Data

SQLite schema: `domains`, `papers`, `authors`, `paper_authors`, `notes`, `llm_jobs`.

`prepareMeta` writes structured JSON onto the paper and authors. It does **not** change `reading_status`. `draftNotes` will not silently overwrite notes you already edited.

## Phase-2 backlog

- Normalize **lab** as a first-class entity and a “same lab” archive view
- Local **PDF ingest** / section slicing to support summaries
- Optional **iCloud** sync
- Citation / route-matrix graph using real bibliography links (no fake HUD)

## License

Original application code in this repository.
