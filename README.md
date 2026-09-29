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

The desktop window is the real app (`npm run tauri dev`). SQLite lives in the app data directory; the API key is stored only in the app config directory (`llm-settings.json`) and is never echoed back to the UI after save. Plaintext keys mirrored into `tauri-plugin-store` by older versions are deleted automatically on every save.

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

**清除已保存的 Key**：系统页 AI 服务设置卡在已保存 Key 时显示「清除已保存的 Key…」，二段确认后本机 `llm-settings.json` 中的 Key 即被删除（`tauri-plugin-store` 里的历史镜像也会一并清掉），状态条回到「未配置 AI」。

## MinerU 解析源 / MinerU providers

导入 PDF 后交给 MinerU 解析。系统页「MinerU 解析源」支持三种来源，每源一张卡片，可单独「测试连接」并看到探测结果（成功含延迟 / 失败原因）：

| 来源 | 适用场景 | 关键字段 |
|---|---|---|
| 本地 CLI | MinerU 文档库与本应用在同一台电脑 | Socket 路径（默认 `~/.mineru/doclib.sock`） |
| SSH 远程 | MinerU 部署在另一台电脑（如 iMac）——**即原有 doclib.sock 方案，字段原样保留，旧部署无需改动** | 主机 / 端口 / 用户 / 私钥 / 远程 Socket 路径 / 远程暂存目录 |
| 官方 API | mineru.net 云端解析，无需本机部署 | Token（在 mineru.net 获取）、模型版本（pipeline / vlm）、语言（中 / 英） |

- **回退顺序**：卡片上方的顺序 chips 可 ↑↓ 调整，保存/导入按该顺序取第一个探测通过的源；「当前生效」一行始终显示实际使用的来源，全部失败时逐条列出失败原因。
- **自动补全**：解析完成后若已配置 AI Key，会自动补全元数据；AI 只填空白字段，从不覆盖你手动改过的内容（`overwrite=false` 语义）。
- **解析档位 / 页码范围**：仅作用于本地与 SSH 的 doclib API；官方 API 用「模型版本」替代档位，页码范围非 `all` 时按页提交。

### 官方 API 限额与错误码

单文件 ≤ 200MB、≤ 200 页、单批 ≤ 50 个文件、每账号每日 1000 页最高优先级额度。常见错误码中文对照：

| 错误码 | 含义 |
|---|---|
| A0202 / A0211 | Token 无效 / Token 过期，请到 mineru.net 重新获取 |
| -60005 | 文件超过 200MB |
| -60006 | 文件超过 200 页 |
| -60018 | 当日 1000 页额度已用尽 |
| -60012 | 任务不存在（正常情况下仅探测连接时出现） |

**Token 存储位置**：桌面端只存于应用配置目录的 `mineru-settings.json`，界面上永不回显（只显示「已保存」），也不会写入 `tauri-plugin-store`。需要删除时用官方 API 卡片上的「清除已保存的 Token…」。

### 解析恢复语义（同源原则）

轮询与恢复**只在同一来源内进行**：doclib 的 short_id 与官方 API 的 batch_id 属于不同命名空间，解析中途换源在客观上只能重新提交。因此：

- 某来源失效（探测失败或轮询报错）时，论文会标记为「解析失败」并提示原因；
- 跨源切换的唯一入口是论文资料栏的「重新解析」按钮：它会重置该论文的解析状态并按回退顺序重新选择来源提交；
- 每篇论文实际使用的来源记录在数据库中（资料栏「解析来源」行），重启后仍可继续轮询。



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
- API Key 等：同目录下的 `llm-settings.json`（MinerU Token 在 `mineru-settings.json`，均不回显）

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
| ⌘N / Ctrl+N | 添加论文（选 PDF / 选文件夹 / 手动添加） |
| ⌘R / Ctrl+R | 标记已读 |
| ⌘K / Ctrl+K | 搜索；系统模式下按它会先跳回现场再聚焦搜索框 |
| Esc | Close dialog / 关闭抽屉 |

## Security notes

`tauri.conf.json` 的 `csp` 目前保持 `null`：XSS 主防线在前端 DOMPurify 消毒层（笔记与解析全文渲染前均经 `renderMarkdown` 消毒），贸然收紧 CSP 需要在 `tauri dev` 下逐一验证 HMR 与 IPC 通道后才可落地。候选收紧值（ws 仅开发期需要）：

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ipc: http://ipc.localhost ws://127.0.0.1:43173
```

敏感信息存储：LLM API Key 仅存于 `llm-settings.json`、MinerU Token 仅存于 `mineru-settings.json`（均在应用配置目录），两者界面均不回显，且各自提供「清除已保存的…」入口；旧版本镜像进 `tauri-plugin-store` 的明文 Key 会在下次保存时被自动删除。

## Tests / 测试

三项门禁与逐文件覆盖说明见 [docs/TEST_REPORT.md](docs/TEST_REPORT.md)：

```bash
npm test                                                   # 前端 vitest（12 文件 / 173 测试）
npm run build                                              # tsc && vite build
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml   # Rust 单测（lib 25 个）
```

## Data

SQLite schema: `domains`, `papers`, `authors`, `paper_authors`, `notes`, `llm_jobs`. `papers.mineru_provider` records which MinerU source parsed each paper (本地 CLI / SSH 远程 / 官方 API).

`prepareMeta` writes structured JSON onto the paper and authors. It does **not** change `reading_status`. `draftNotes` will not silently overwrite notes you already edited, and `prepareMeta` asks before overwriting fields you edited by hand (「保留我的修改」only fills blanks).

## Phase-2 backlog

- Normalize **lab** as a first-class entity and a “same lab” archive view
- Local **PDF ingest** / section slicing to support summaries
- Optional **iCloud** sync
- Citation / route-matrix graph using real bibliography links (no fake HUD)

## License

Original application code in this repository.
