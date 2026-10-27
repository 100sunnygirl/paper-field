# Paper list and notes

Search the list, open a paper, write one note block, save it.

## Sub-features

- 搜索论文 (`#global-search`) filters the current domain and opens 跨领域搜索结果 (`aria-label` 跨领域搜索结果) with the line 全部领域共匹配.
- Seeded CLIP paper: Chinese title 从自然语言监督中学习可迁移视觉模型, English title without the letters CLIP, tag `clip`. Searching `CLIP` matches the tag and also 视觉指令微调 (its abstract mentions CLIP).
- Empty note blocks render 写总结 / 写亮点 / 写不足 / 写启示 / 写备注. CLIP's blocks are empty. 视觉指令微调 already has text, so those blocks show 编辑 instead of 写.
- Editing shows textarea `aria-label` 总结内容, hint 编辑中 · 尚未保存, buttons 取消 and 保存笔记.
- After save the block shows the text and the source 手动笔记.

## How to get to it (user POV)

Stay on 阅读. Type CLIP into 搜索论文. In the dropdown 全部领域, click 从自然语言监督中学习可迁移视觉模型. On the stage, under 阅读笔记, click 写总结, type, then 保存笔记. The hint changes from 编辑中 · 尚未保存 to the saved paragraph.

## Driving it with Playwright

- `getByRole("textbox", { name: "搜索论文" }).fill("CLIP")`.
- Click the button matching the Chinese CLIP title inside `[aria-label="跨领域搜索结果"]`, not the first list row. Both LLaVA and CLIP match the query.
- Wait for `heading` level 1 named the Chinese CLIP title.
- `getByRole("button", { name: "写总结" })`, then textbox 总结内容.
- Fill a sentence that is not in the seed, assert 编辑中 · 尚未保存, click 保存笔记.
- Assert the sentence and 手动笔记 inside `#note-summary`.

## Gotchas

- The accessible name of a paper row includes the index, 在读/已读, both titles, venue, and author. Match the Chinese title with a regex.
- Escape while the search box is focused closes the dropdown only (`stopPropagation`). Escape elsewhere also closes dialogs and the jobs panel.
- Notes are edited in the document, not in ⋯ 更多操作. 更多操作 is 编辑论文信息, 移动到其他领域, 删除论文.
- 保存笔记 persists through sql.js into IndexedDB. The next journey uses a new context, so this edit does not leak.
