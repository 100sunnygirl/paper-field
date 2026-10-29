# Reading next

One fresh library. The journey shows the new controls and does not import a PDF, start a model call, or swap a backup.

## Sub-features

- 添加论文 opens a dialog with 导入到. Choosing 指令对齐 leaves the field on 多模态. The dialog closes without an import.
- The filename row's heading text is only `visual-instruction-tuning.pdf`. 文件名 sits outside that heading.
- 写总结 opens an empty draft. 保存全部 and the footer 笔记草稿 1 appear only then. Ctrl S on the empty textarea flashes 笔记已保存。 and both indicators go away.
- A filled 搜索论文 box is empty after 切换研究领域 to 指令对齐.
- 批量选择论文 shows 移动到领域 and 标为已读. Neither button is clicked.
- 设置 has an anchor for each block, including 密钥. 导出全部领域 is visible and not clicked. The 密钥 block lists AI Key, MinerU Token, OpenAlex Key, and Semantic Scholar Key as 未配置, with no input and no secret text.

## How to get to it (user POV)

Open 添加论文 and look at 导入到, then close it. Find the filename row in 论文列表. Write an empty 总结 and save it from the keyboard. Search, then switch to 指令对齐. Turn on 批量选择论文. Open 设置 and read the anchors, 导出全部领域, and 密钥.

## Driving it with Playwright

Viewport 1600×1000. Fresh context so the seed loads again.

- 添加论文, wait for the combobox 导入到, select 指令对齐, and confirm 切换研究领域：多模态 is still the switcher. Close the dialog. Do not click 创建论文 or 选择 PDF.
- On the filename row, the heading text is the title and does not contain 文件名. The row still shows 文件名.
- Open that paper. 保存全部 is absent. 写总结, then 保存全部 and footer 笔记草稿 1. Focus 总结内容 and press Control+s. Wait for 笔记已保存。 保存全部 is hidden and the footer no longer says 笔记草稿.
- Fill 搜索论文 with `clip`, open 切换研究领域, choose 指令对齐, and read an empty search box.
- 批量选择论文, then wait for 移动到领域 and 标为已读. Do not click them.
- 设置. Each settings link's href is an element id. Wait for 导出全部领域. In `#settings-keys`, the four key labels are present, an input is not, and the text has no `sk-`, `eyJ`, `apiKeyDraft`, or `Bearer `.

## Gotchas

- Do not click 起草所选, 导出全部领域, 恢复, or 确认恢复.
- Ctrl S has to land on the note textarea. A window-level keydown does not save the note.
- Switching domain clears the search box in the same update. Do not wait for a search result before switching.
- The filename badge check is on the list heading, before the stage title is the same string.
