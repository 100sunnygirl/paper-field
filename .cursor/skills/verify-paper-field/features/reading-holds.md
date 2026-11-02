# Reading holds

Six holds on the open paper. The browser can show five of them. It cannot swap a backup or call a model.

## Sub-features

- visual-instruction-tuning.pdf is unread in 多模态. Its title source is 文件名. The stage `h1` shows that badge and a 认领标题 button. Claiming keeps the same words, flashes 标题已记为你的。, and removes the badge.
- 写总结 on an empty block, then 保存笔记 with no typing, flashes 笔记已保存。 The block stays empty and does not gain 手动笔记.
- 更多操作 → 移动到其他领域. The dialog stays 移动到其他领域. 新领域名称 plus 创建并移入 creates the domain, moves the locked paper, and the switcher follows it.
- A Ctrl R keydown flashes 已将「visual-instruction-tuning.pdf」标为已读。 with 撤销. 撤销 flashes 已撤销标记已读。 and the 修改阅读状态 value is `unread` again. The footer stays 已读 1 / 4.
- 设置 can add Ollama 本地（免 Key） and 保存设置. Back on 阅读, 起草阅读笔记 opens 起草哪些笔记. The five blocks are 总结, 亮点, 不足, 启示, 备注. 取消 closes it. 起草所选 is not clicked, so no model call runs.
- 设置 → 恢复 → 确认恢复 flashes 备份与恢复仅在桌面版可用。 The dialog 恢复前的文献 does not open.

## How to get to it (user POV)

Open the filename row in 论文列表. Claim the title. Save the empty 总结 without typing. Move the paper into a new domain named 对齐验收. Press Ctrl R and undo. Add the keyless Ollama preset, return, open the note checklist, and cancel. Confirm restore from 设置 and read the desktop-only toast.

## Driving it with Playwright

Viewport 1600×1000. Fresh context so the fourth seed paper exists.

- Click the filename row. Wait for the level-1 heading, the exact text 文件名, and 认领标题.
- After claim, 认领标题 is hidden and 文件名 is gone. The heading text is unchanged.
- 写总结, then 保存笔记. Wait for 笔记已保存。 `#note-summary` shows 写总结 again and does not show 手动笔记.
- 更多操作, 移动到其他领域, fill 新领域名称 with 对齐验收, 创建并移入. Wait for 切换研究领域：对齐验收.
- Dispatch Ctrl R on `window` (a real browser accelerator may reload). Click 撤销 inside that status toast.
- Select 提供商预设 `Ollama 本地（免 Key）`, 添加提供商, 保存设置, then 阅读 and 起草阅读笔记. Cancel the dialog.
- 恢复, then 确认恢复. Wait for the desktop-only status. Do not expect 恢复前的文献.

## Gotchas

- A library that was seeded before this paper existed will not show the filename row. The journey uses a new context.
- The 阅读状态 select updates status without an undo button. Only the Ctrl R toast has 撤销.
- 起草阅读笔记 stays disabled until a usable provider exists. The journey adds Ollama and does not submit 起草所选.
- The margin line needs a saved field to change while a draft is open, which a model write does. This journey does not claim that line.
