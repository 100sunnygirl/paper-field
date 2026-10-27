# Reading shell

The workstation chrome: charcoal dock, mode rail, paper list, document stage, context rail, status strip.

## Sub-features

- Dock brand `PAPER FIELD` and subtitle 论文阅读工作台. The dock has no search and no 添加论文.
- 主导航 buttons: 阅读, 归档, 入库, and 设置 at the bottom of the rail. The current mode sets `aria-current="page"`.
- 阅读 shows the selected domain. The seed selects 多模态 (`aria-label` 切换研究领域：多模态) and lists 视觉指令微调 and 从自然语言监督中学习可迁移视觉模型.
- 归档 heading 归档 lists only papers the user marked 已读. On a fresh seed that is 视觉指令微调 only.
- 入库 heading 入库 lists papers not marked 已读, across domains: the CLIP paper and 用人类反馈训练语言模型遵循指令.
- 设置 replaces the list and stage with the settings page (`h1` 设置).
- Status strip (`footer.ef-status`): 已读 1 / 3, 开源 count, 队列空闲, 尚未配置 AI 服务, MinerU 未配置, and a 搜索 hint.

## How to get to it (user POV)

Open `http://127.0.0.1:43173`. Wait until the loading bar 正在打开阅读工作台 is gone and the left rail shows 阅读. Click 归档, 入库, or 设置 on that rail. Click 阅读 to come back. Click a row in 论文列表 to open it on the stage; the stage title is an `h1` and 阅读笔记 sits under the abstract.

## Driving it with Playwright

Viewport 1600×1000 so the list and the stage are both columns (see Gotchas).

- `openWorkstation` waits for `navigation` 主导航 and `listbox` 论文列表, then a row whose name matches 视觉指令微调.
- Mode changes go through `clickMode` (the button inside 主导航, exact name).
- Counts use `footer.ef-status` text `已读 1 / 3`, `队列空闲`, `尚未配置 AI 服务`, `MinerU 未配置`.
- After 归档, the listbox contains 视觉指令微调 and does not contain the CLIP title. After 入库, the CLIP title and 用人类反馈训练语言模型遵循指令 are present and 视觉指令微调 is not.
- 设置 is `heading` level 1 named 设置. Returning to 阅读 restores 切换研究领域：多模态.
- Open 视觉指令微调 and expect `heading` 阅读笔记.

## Gotchas

- `@media (max-width: 1399px)` hides `.ef-context`. `@media (max-width: 1100px)` turns `.ef-nav` into a drawer opened by 论文列表. Drive at 1600×1000.
- 归档 and 入库 are `h2`s in the list column, not the rail button. Scope rail clicks to 主导航.
- The status strip counts every domain. The 阅读进度 line in the list column counts only the current domain (已读 1 / 2 for 多模态). Do not assert the footer against the list-column fraction.
- Fresh context each journey. A reused profile keeps IndexedDB `paper-field` and will not reseed.
- 打开 PDF and 补充 PDF are not part of this journey. ArXiv links call the desktop opener or `window` navigation.
