# Paper Field / 论文现场

Local-first research-paper notes for macOS and Windows. Organize papers by research domain, let an optional LLM fill structured metadata, then write notes in your own voice and mark read yourself.

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
- **Jobs panel (作业面板):** click the strip's job segment or press ⌘J to see what is running — batch progress, per-job stage and page progress, the queue and recent results
- Search and Markdown export of a domain
- Keyboard: ↑↓ list, ⌘N 添加论文, ⌘R 标记已读, ⌘K 搜索
- Move paper across domains via 更多 → 移动到其他领域; delete requires a confirm dialog

## Run from source

Prerequisites:

1. **Node.js 20+** (npm)
2. **Rust stable** via [rustup](https://rustup.rs)
3. macOS 15+: Xcode Command Line Tools (`xcode-select --install`)
4. Windows 10+ x64: Visual Studio Build Tools with **Desktop development with C++**, and Microsoft Edge WebView2 Runtime

```bash
git clone <this-repo>
cd paper-field
npm install
npm run tauri dev
```

The desktop window is the real app (`npm run tauri dev`). SQLite lives in the platform app data directory. LLM API keys and the MinerU token are stored in the macOS Keychain (Windows Credential Manager on Windows). The settings files keep provider URLs and models only; keys are not written back into `llm-settings.json` or `mineru-settings.json`. On Linux, where this repo's dev VM has no Keychain, the same values go to a mode-0600 `secrets.json` beside the settings files. Browser preview still keeps keys in `localStorage`. Plaintext keys mirrored into `tauri-plugin-store` by older versions are deleted automatically on every save.

To ship a `.app` / `.dmg` on macOS:

```bash
npm run tauri build
```

To ship the Windows NSIS installer:

```powershell
npm run tauri build -- --target x86_64-pc-windows-msvc
```

The installer is emitted under `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\`.

After merging, pushing a `v*` tag triggers the Desktop workflow. GitHub builds the Windows installer and a universal macOS `.dmg` in the cloud, then attaches both plus `SHA256SUMS.txt` to the same GitHub Release.

### UI-only preview (browser)

`npm run dev` serves the React shell at `http://127.0.0.1:43173` with a sql.js + IndexedDB fallback. Use this when you do not want to launch the Tauri webview stack. Browser LLM calls may fail CORS; the desktop app proxies completions in Rust.

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

**清除已保存的 Key**：系统页 AI 服务设置卡在已保存 Key 时显示「清除已保存的 Key…」，二段确认后 Keychain（或 Linux 上的 `secrets.json`）中的 Key 即被删除（`tauri-plugin-store` 里的历史镜像也会一并清掉），状态条回到「未配置 AI」。

**文献库著录**：不配置也能查。系统页「文献库」里的联系邮箱、OpenAlex Key、Semantic Scholar Key 都是可选项，只改变请求走公共池还是礼貌池 / 个人额度，不改变查哪些库、按什么顺序查。联系邮箱只发给 Crossref（`mailto` 和 User-Agent），不会发给 OpenAlex。两个 Key 进系统钥匙串（Linux 上是 `secrets.json`），不会写进设置 JSON。

查询顺序固定：有 arXiv id 时先问 arXiv，再用 Semantic Scholar 补 DOI 和期刊；有 DOI 时先问 Crossref，再问 OpenAlex 的单条 DOI（这条不占搜索额度）；只有标题时先问 OpenAlex 搜索，再问 Semantic Scholar 的标题匹配，最后问 Crossref。标题 Jaccard 低于 0.82 就丢掉。返回的 DOI 或 arXiv id 必须和请求的一致，对不上就记一笔原因并继续下一个来源，不会因为 429、403 或断网停掉整次查询。全部落空之后才把仍然空白的字段交给模型。来源徽章会写成「数据库 · Crossref」这样的具体库名。某个库因为没配置而失败时，结果旁边有一行说明，并链到设置里的文献库。

文献库查到的值会替换此前由模型填上的字段（包括旧库里迁移时标成「模型」的字段）。你手改过的字段仍然保留，除非在确认对话框里选择覆盖。同一次查询不会用一个文献库的值换掉另一个文献库已经写下的值；「刷新链接」会重新查询并允许文献库之间更新。标题对不上时仍由模型按原来的「模型」徽章补全，不另加待核实标记。

手动添加时只要填了 arXiv 或 DOI，即使没有 PDF 也会查一次。同一篇论文的查询结果会在本地缓存约一天。代码链接和项目页写入前做 HTTP HEAD/GET，打不开就丢掉。档案侧栏的「刷新链接」只做这次查询，不调用模型。

**备份与恢复**：系统页「数据导出」旁有「备份」和「恢复」。备份是一个 zip：`paper-field.db`、文库里的 PDF、以及不含密钥的设置 JSON。恢复前会先把当前数据库复制为 `paper-field.db.pre-restore-<时间>`，确认后才替换。导入 PDF 时桌面版把文件复制进应用支持目录的 `library/`，原路径留在 `pdf_original_path`。

## MinerU 解析源 / MinerU providers

导入 PDF 后交给 MinerU 解析。系统页「MinerU 解析源」支持三种来源，每源一张卡片，可单独「测试连接」并看到探测结果（成功含延迟 / 失败原因）：

| 来源 | 适用场景 | 关键字段 |
|---|---|---|
| 本地 CLI | MinerU 文档库与本应用在同一台电脑 | Socket 路径（默认 `~/.mineru/doclib.sock`） |
| SSH 远程 | MinerU 部署在另一台电脑（如 iMac）——**即原有 doclib.sock 方案，字段原样保留，旧部署无需改动** | 主机 / 端口 / 用户 / 私钥 / 远程 Socket 路径 / 远程暂存目录 |
| 官方 API | mineru.net 云端解析，无需本机部署 | Token（在 mineru.net 获取）、模型版本（pipeline / vlm）、语言（中 / 英） |

Windows notes: local doclib access requires a curl build with `--unix-socket` support (Windows System32 curl provides it); SSH remote requires the optional OpenSSH Client feature. The installer is currently unsigned, so Windows SmartScreen may show a warning before you choose **More info → Run anyway**.

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


## 作业面板 / Jobs panel

底部状态条的「作业运行中 / 作业等待 / 队列空闲」一格可以点击（或按 ⌘J），从状态条上拉出作业面板；入库页的作业区也有入口。面板是非模态浮层，打开时仍可继续阅读，Esc 或再按一次 ⌘J 收起。

| 区块 | 展示什么 |
|---|---|
| 计数带 | 运行中 / 排队（含批次里尚未开始的论文）/ 本次启动以来完成与失败的作业数 |
| 批次卡 | 一次导入、重试或自动补全提交的整批论文：一篇一格的逐篇色块（完成 / 失败 / 取消 / 处理中 / 排队，超过 48 篇改为连续分段条）、成功失败小结、已用时间，以及按已完成各篇平均耗时估算的剩余时间。连续失败熔断后显示为「已暂停」并给出指引；进行中的 MinerU 批次可「停止本批」（二次确认） |
| 进行中 | 每个作业一张卡：阶段刻度（MinerU：提交 → 解析 → 取回全文；AI：排队 → 请求模型 → 写入结果）、实际解析源或首选 AI 提供商、官方 API 回报的「已解析 n / 总页数」进度条、总用时与本阶段用时，可取消；标题可点，直接跳到该论文 |
| 排队 | 当前批次与后续批次中尚未开始的论文，「下一篇」置顶；MinerU 排队论文可单独移出队列（轮到时跳过，不提交解析） |
| 最近结束 | 最近 12 个已结束作业的结果、失败原因、用时与结束时刻；某篇最近一次解析失败或被取消时可直接「重新解析」 |

数据来源：作业状态以 `llm_jobs` 表为准；阶段、批次与页进度是运行时实况（`src/lib/activity.ts`，只存内存，重启即清空——与启动时把残留作业清扫为「应用上次退出」的语义一致）。

## 从源码安装 / Install from source

前置：macOS 15+、Xcode CLT（`xcode-select --install`）或 Windows 10+ x64、Visual Studio Build Tools（Desktop development with C++）、Rust（[rustup](https://rustup.rs)，stable MSVC）、Node.js 20+。

```bash
git clone https://github.com/100sunnygirl/paper-field.git
cd paper-field
npm install

# 开发运行（桌面窗口）
npm run tauri dev

# macOS：打可双击的 .app / .dmg
npm run tauri build

# Windows：打 NSIS 安装包
npm run tauri build -- --target x86_64-pc-windows-msvc
```

安装到「应用程序」：

```bash
APP="src-tauri/target/release/bundle/macos/Paper Field.app"
rm -rf "/Applications/Paper Field.app"
cp -R "$APP" "/Applications/Paper Field.app"
xattr -dr com.apple.quarantine "/Applications/Paper Field.app"
open "/Applications/Paper Field.app"
```

Windows 直接运行 `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\Paper Field_0.2.16_x64-setup.exe`。默认按当前用户安装，不需要管理员权限；安装器会在缺少 WebView2 Runtime 时在线引导安装。

首次 release 编译会较久；之后增量会快很多。

## 更新代码后如何更新软件 / Update after pulling

本地笔记数据在应用数据目录，**不在** `.app` 包内，替换应用一般不会丢数据：

应用数据目录跟 bundle identifier 走。当前标识是 `com.paperfield.notes`（不再使用以 `.app` 结尾的 `com.paperfield.app`，那个后缀会让 macOS 把数据目录当成应用程序包，Tauri 也会在打包时警告）。

- macOS：`~/Library/Application Support/com.paperfield.notes/paper-field.db`
- Windows：`%APPDATA%\com.paperfield.notes\paper-field.db`（即 `C:\Users\<你>\AppData\Roaming\com.paperfield.notes\`）
- Linux 配置（含数据库、文库与设置）：`~/.config/com.paperfield.notes/`，若设置了 `XDG_CONFIG_HOME` 则用那个目录。数据目录是 `~/.local/share/com.paperfield.notes/`（或 `XDG_DATA_HOME`）
- 文库 PDF：同目录下的 `library/`
- 设置（不含密钥）：同目录下的 `llm-settings.json`、`mineru-settings.json`、`biblio-settings.json`（界面不回显 Key）
- 密钥：macOS Keychain / Windows Credential Manager，服务名仍是 `paper-field`（不随 bundle identifier 改成 `com.paperfield.notes`，所以换包之后原来的 Key 还在同一条钥匙串记录里）。Linux 为同目录 `secrets.json`（权限 0600）。浏览器预览仍用 `localStorage`。

**从旧目录迁移（只复制一次）**：第一次启动时，如果新目录还不存在或是空的，并且旧目录 `com.paperfield.app` 还在（macOS 的 `~/Library/Application Support/com.paperfield.app`、Windows 的 `%APPDATA%\com.paperfield.app`、Linux 的 `~/.config/com.paperfield.app` 与 `~/.local/share/com.paperfield.app`），应用会在打开数据库之前把旧目录里的全部内容**复制**到新目录。这包括 `paper-field.db`、`library/`、`llm-settings.json`、`mineru-settings.json`、`biblio-settings.json`，以及 Linux 上的 `secrets.json`。钥匙串里的密钥不在这个目录里，服务名保持 `paper-field`，不会因为换 identifier 而改名。旧目录留在原地，不会被删，也不会覆盖新目录里已经有的文件。复制成功后新目录里会留下标记文件 `.migrated-from-com.paperfield.app`，之后即使把新目录清空也不会再复制一次。终端里会有一行 `[paper-field] 已将应用数据从 … 复制到 …`。

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

## 签名、公证和自动更新 / Signing, notarization, and updates

桌面安装包默认可以**不签名**打出来。GitHub Actions 只有在下面这些仓库 Secrets 都已经填好时才会签名；缺任何一个，对应的步骤会跳过，Windows 安装包和 macOS `.dmg` 仍然会构建成功。不要把私钥或证书提交到仓库。

### 1. Apple 签名和公证（只影响 macOS）

需要一个 [Apple Developer](https://developer.apple.com/programs/) 账号（年费，用你自己的 Apple ID 注册）。证书和公证都在这个账号下完成。

1. 用钥匙串访问或 Xcode 生成一个 **Developer ID Application** 证书，并导出为 `.p12`（导出时设一个密码，记下来）。
2. 在终端把证书编成一行文本（macOS）：

   ```bash
   base64 -i Certificates.p12 | pbcopy
   ```

3. 打开 GitHub 仓库 → **Settings → Secrets and variables → Actions → New repository secret**，逐个添加：

   | Secret | 填什么 |
   |---|---|
   | `APPLE_CERTIFICATE` | 上一步复制的整段 base64（一行，不要换行） |
   | `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设的密码 |
   | `APPLE_SIGNING_IDENTITY` | 钥匙串里证书的全名，例如 `Developer ID Application: Your Name (TEAMID)` |
   | `APPLE_ID` | 你的 Apple ID 邮箱 |
   | `APPLE_PASSWORD` | 在 [account.apple.com](https://account.apple.com) 生成的 **App 专用密码**，不是 Apple ID 登录密码 |
   | `APPLE_TEAM_ID` | 开发者账号的 Team ID，10 位，在 [developer.apple.com/account](https://developer.apple.com/account) 的会员详情里 |

   这五项（外加证书密码）必须一起存在。少一个，工作流会当作未签名构建，避免公证走到一半失败。

4. 推一个 `v*` tag（例如 `v0.2.15`）。macOS 任务会导入证书、用该身份签名，并把 `.dmg` 提交公证。公证由 Apple 异步处理，第一次可能要几分钟；Tauri 会等公证结果。没有这些 secret 时，发布说明里会保留 Gatekeeper 的打开办法。

### 2. 更新签名密钥（检查更新用）

自动更新用另一对密钥，和 Apple 证书不是同一个。公钥写进应用，私钥只放在 GitHub Secret 里。

1. 在自己的电脑上生成（不要加到 git）：

   ```bash
   npm run tauri signer generate -- -w "$HOME/.tauri/paper-field.key"
   ```

   命令会问一个密码（可以留空）。它打印两段内容：公钥，以及私钥文件路径。私钥文件在 `~/.tauri/paper-field.key`，只留在你的电脑和 GitHub Secret 里。

2. 用打印出来的公钥**替换** `src-tauri/tauri.conf.json` 里 `plugins.updater.pubkey` 的整段值。现在这段是占位公钥：解码后的注释里有 `PLACEHOLDER`。占位期间，设置页的「检查更新」不会联网，只提示尚未配置公钥。换成你自己的公钥并重新打包之后，按钮才会真正检查。

3. 把私钥文件的**全部内容**存成 Secret `TAURI_SIGNING_PRIVATE_KEY`（不是文件路径；把文件打开，从 `untrusted comment` 起整段复制）。如果生成时设了密码，再加 Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。没有私钥时，工作流会把 `createUpdaterArtifacts` 关掉，安装包照常产出，只是没有 `.sig` 和 `latest.json`。

4. 再推一个 `v*` tag。带私钥的构建会多出：

   - macOS：`*.app.tar.gz` 和同名 `.sig`（通用二进制同时给 `darwin-aarch64` 和 `darwin-x86_64`）
   - Windows：`*.nsis.zip` 和同名 `.sig`
   - 发布任务把这些收成 `latest.json`，地址是  
     `https://github.com/100sunnygirl/paper-field/releases/latest/download/latest.json`

### 3. 用户如何更新

1. 安装的应用必须是用**你的公钥**打出来的那一版。占位公钥的版本点「检查更新」只会看到说明，不会下载。
2. 打开 **设置**，在「软件更新」里点 **检查更新**。
3. 已是最新：提示「已是最新版本。」
4. 有新版本：应用下载 GitHub Release 里的更新包，核对签名，安装后重新打开。Windows 安装更新时窗口会退出，这是安装器的限制。
5. 签名对不上、网络失败，或 Release 里还没有 `latest.json`：按钮下面显示失败原因，笔记数据不动。

本地笔记在上面的应用数据目录里，不在 `.app` 包内。换包或自动更新都不会清掉已经迁移过去的数据库。

## Keyboard

| Shortcut | Action |
|---|---|
| ↑ / ↓ | Move in the current paper list |
| ⌘N / Ctrl+N | 添加论文（选 PDF / 选文件夹 / 手动添加） |
| ⌘R / Ctrl+R | 标记已读 |
| ⌘K / Ctrl+K | 搜索；系统模式下按它会先跳回现场再聚焦搜索框 |
| ⌘J / Ctrl+J | 打开 / 收起作业面板 |
| Esc | Close dialog / 关闭抽屉 / 收起作业面板 |

## Security notes

`tauri.conf.json` 的 `csp` 目前保持 `null`：XSS 主防线在前端 DOMPurify 消毒层（笔记与解析全文渲染前均经 `renderMarkdown` 消毒），贸然收紧 CSP 需要在 `tauri dev` 下逐一验证 HMR 与 IPC 通道后才可落地。候选收紧值（ws 仅开发期需要）：

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ipc: http://ipc.localhost ws://127.0.0.1:43173
```

敏感信息存储：LLM API Key 与 MinerU Token 在 macOS 写入 Keychain、在 Windows 写入 Credential Manager（Linux 开发环境写入权限 0600 的 `secrets.json`）。`llm-settings.json` / `mineru-settings.json` 只留非密钥配置；首次启动会把旧文件里的明文 Key 迁出，并清掉文件本身和 `.v1.bak` 里的 `sk-` / Bearer 片段。界面不回显，且各自提供「清除已保存的…」入口。作业错误和运行日志会打掉 `sk-` 与 `Bearer` 片段。旧版本镜像进 `tauri-plugin-store` 的明文 Key 会在下次保存时被自动删除。外链只接受 `http`/`https`，由系统浏览器打开。

## Tests / 测试

三项门禁与逐文件覆盖说明见 [docs/TEST_REPORT.md](docs/TEST_REPORT.md)：

```bash
npm test                                                   # 前端 vitest
npm run build                                              # tsc && vite build
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml   # Rust 单测
```

Windows PowerShell equivalent:

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

## Data

SQLite schema: `domains`, `papers`, `authors`, `paper_authors`, `notes`, `llm_jobs`. `papers.mineru_provider` records which MinerU source parsed each paper (本地 CLI / SSH 远程 / 官方 API). `papers.field_sources` records per-field provenance (`api` 数据库 / `llm` 模型 / `user` 手动). `PRAGMA user_version` is the migration cursor (currently 4). On an existing library the app copies the database aside (`paper-field.db.premigrate-<时间>`, or IndexedDB `paper-field.db.premigrate` in the browser) before applying ordered migrations, then backfills non-empty fields so the first lookup does not clobber them. A corrupt settings file is left untouched; it is not treated as a v1 migration.

`prepareMeta` writes structured JSON onto the paper and authors. It does **not** change `reading_status`. Bibliographic lookup runs first and marks filled fields `api`. The model only fills fields still empty (`titleZh`, tags, labs, code-link guess) and those are marked `llm`. The default is fill-empty-only. 「用 AI 结果覆盖」 is the only path that passes `overwrite=true`, and a field edited while that request was in flight is still kept. `draftNotes` will not silently overwrite notes you already edited; an explicit overwrite marks the blocks `llm`.

## Phase-2 backlog

- Normalize **lab** as a first-class entity and a “same lab” archive view
- Local **PDF ingest** / section slicing to support summaries
- Optional **iCloud** sync
- Citation / route-matrix graph using real bibliography links (no fake HUD)

## License

Original application code in this repository.
