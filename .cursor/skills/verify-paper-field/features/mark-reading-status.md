# Mark reading status

The user, not the model, moves a paper between 未读, 在读, and 已读.

## Sub-features

- The control is a native `<select aria-label="修改阅读状态">` in the 资料 rail, under the heading 阅读状态. Options are 未读, 在读, 已读 (`value` unread / reading / read).
- Seed: 视觉指令微调 is 已读, the CLIP paper is 在读, InstructGPT is 未读, and visual-instruction-tuning.pdf is 未读. Footer 已读 1 / 4.
- Changing the select calls `setReadingStatus` and toasts 阅读状态已更新为已读。 (role `status`). The footer becomes 已读 2 / 4. The select does not offer 撤销. That action belongs to the Ctrl R toast.
- 归档 then lists both 已读 papers. The hint under the select for a non-read paper is 阅读状态由你手动标记; after 已读 it becomes 标记于 and a date.
- Ctrl R / ⌘ R also marks the open paper 已读, except while typing, while a dialog is open, or on 设置.

## How to get to it (user POV)

On 阅读, click 从自然语言监督中学习可迁移视觉模型 in the list. In the right rail, open the 阅读状态 menu (it shows 在读) and choose 已读. The status strip's 已读 count goes from 1 to 2. Click 归档. Both that paper and 视觉指令微调 are in the list.

## Driving it with Playwright

- Viewport 1600×1000. Under 1400px the rail is `display: none` and 修改阅读状态 is not visible until 资料 is clicked. This journey does not use the drawer.
- Click the CLIP row inside `listbox` 论文列表. Wait for the level-1 heading.
- `getByLabel("修改阅读状态")` input value is `reading`. `selectOption({ label: "已读" })`.
- Wait for `status` 阅读状态已更新为已读 and footer text 已读 2 / 4.
- `clickMode(page, "归档")`, then both Chinese titles are rows in 论文列表.

## Gotchas

- The list column also says 已读 inside each row and inside 阅读进度. Scope the fraction to `footer.ef-status`.
- Marking 已读 does not call the LLM and does not need MinerU. Do not click 补全论文信息 or 起草阅读笔记; both need a configured provider (补全 is disabled; 起草 still attempts a job).
- 归档 hides 添加论文. Switch back to 阅读 before a later journey in the same context. `drive.mjs` already isolates contexts.
- The toast is `role="status"`. Errors use `role="alert"`. Match the success string so a failure toast does not pass.
