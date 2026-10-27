# System settings

The 设置 page: providers, export, backup, shortcuts, MinerU cards, bibliography email. Browser preview stores secrets in `localStorage`, not the keychain.

## Sub-features

- `h1` 设置. Sections, as `h3`: AI 服务设置, 数据导出, 备份与恢复, 快捷键, 软件更新, MinerU 解析源, 文献库, plus 运行日志.
- With no provider saved, AI 服务设置 shows 尚未配置任何 AI 服务.
- MinerU cards are `region`s named 本地 CLI, SSH 远程, and 官方 API. Each has 测试连接. Probing a socket or mineru.net is out of scope for this journey.
- 快捷键 lists 添加论文（导入 PDF / 手动录入） and 标记已读.
- 文献库 field 联系邮箱, button 保存文献库设置. A saved address with `@` and no spaces flips the Crossref row from 匿名 to 已配置. Inline confirmation is exactly 文献库设置已保存。 The toast adds a second sentence about public rate limits.
- 备份 and 恢复 call the desktop backup API. In the browser that rejects. Do not click them.

## How to get to it (user POV)

Click 设置 at the bottom of the left rail. Scroll the settings column. Under 文献库, type an email into 联系邮箱 and click 保存文献库设置. The Crossref line in that card changes to 已配置. Leave AI keys, MinerU tokens, 测试连接, 检查更新, 备份, and 恢复 alone.

## Driving it with Playwright

- `clickMode(page, "设置")`, then `heading` level 1 设置.
- For each of AI 服务设置, 数据导出, 备份与恢复, 快捷键, MinerU 解析源, 文献库: `scrollIntoViewIfNeeded` on the exact heading, then wait until it is visible.
- `getByText("尚未配置任何 AI 服务")`.
- Regions 本地 CLI, SSH 远程, 官方 API.
- Text 添加论文（导入 PDF / 手动录入） and exact 标记已读.
- Scope the form to `article` that contains heading 文献库. Textbox 联系邮箱 fill `verify-paper-field@example.com`. Click 保存文献库设置.
- `getByText("文献库设置已保存。", { exact: true })` matches the inline line, not the longer toast.
- That article's `li` that has Crossref also has 已配置.

## Gotchas

- Several buttons are named 保存设置 (AI block and MinerU block). The bibliography button is 保存文献库设置. Scope clicks to the 文献库 article.
- 测试连接, 检查更新, 获取模型列表, 备份, and 恢复 leave the browser preview: they call Tauri or the network. A failure there is not a regression in this journey.
- The email is stored in `localStorage` key `paper-field.biblio`. A fresh context does not see the previous journey's value.
- Do not type an API key into the journey. Browser preview keeps keys in `localStorage`; the desktop app uses the keychain or Linux `secrets.json`. The smoke test must not need a secret.
