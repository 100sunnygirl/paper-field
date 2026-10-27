# Browser-preview features

These files describe the user-visible behavior `drive.mjs` is allowed to prove. Labels are the Chinese strings in this repo. Selectors that are not in the feature file are guesses.

| Journey | File | Entry the person uses |
|---|---|---|
| `reading-shell` | [reading-shell.md](reading-shell.md) | 主导航: 阅读, 归档, 入库, 设置 |
| `paper-list-and-notes` | [paper-list-and-notes.md](paper-list-and-notes.md) | 搜索论文, then 写总结 |
| `add-paper-manual` | [add-paper-manual.md](add-paper-manual.md) | 添加论文, then 创建论文 |
| `mark-reading-status` | [mark-reading-status.md](mark-reading-status.md) | 资料 rail, 修改阅读状态 |
| `system-settings` | [system-settings.md](system-settings.md) | 主导航 设置 |

Run one journey or all of them:

```bash
.cursor/skills/verify-paper-field/scripts/drive-smoke.sh reading-shell
.cursor/skills/verify-paper-field/scripts/drive-smoke.sh all
```

First-launch seed (empty IndexedDB): domains 多模态 and 指令对齐; papers 视觉指令微调 (已读), 从自然语言监督中学习可迁移视觉模型 (在读), 用人类反馈训练语言模型遵循指令 (未读). Status strip starts at 已读 1 / 3.
