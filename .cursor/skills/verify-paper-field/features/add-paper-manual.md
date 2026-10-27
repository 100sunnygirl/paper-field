# Add a paper by hand

Create a paper with a title and no PDF. This is the browser-preview stand-in for 导入 PDF.

## Sub-features

- 添加论文 sits at the bottom of the list on 阅读 and 入库. It is absent on 归档. The shortcut hint is Ctrl N on Linux and ⌘ N on macOS.
- The dialog title is 添加论文 until files are chosen. In the browser the body says 浏览器预览不能读取本机 PDF，仍可手动添加论文。完整导入请在桌面应用中进行。 There is no 选择 PDF button.
- Manual fields: 标题（必填）, arXiv ID, DOI. Button 创建论文. Empty title shows 标题必填。没有 PDF 也可以先建条目，之后可通过「编辑论文信息」补充。
- A created paper closes the dialog, selects the new row, and toasts 已创建「…」，正在查询文献库。 The stage `h1` is the title when there is no Chinese title.
- The new row is user-owned, so a later bibliography lookup does not replace the title.

## How to get to it (user POV)

On 阅读, in 多模态, click 添加论文 at the bottom of the list (or press Ctrl N). Leave arXiv and DOI empty. Type a title that is obviously not a real paper. Click 创建论文. The dialog closes and the new title is the page heading and a row in 本领域论文.

## Driving it with Playwright

- `getByRole("button", { name: /添加论文/ })` (the name includes the shortcut, so it is not exact).
- Dialog `getByRole("dialog", { name: "添加论文" })`.
- Assert the dialog contains 浏览器预览不能读取本机 PDF.
- Textbox 标题（必填） fill `浏览器预览验收条目`. Click 创建论文.
- Wait until the dialog is hidden, `heading` level 1 is that title, the 论文列表 row exists, and the toast matches 已创建「浏览器预览验收条目」.

## Gotchas

- Do not click 打开 PDF, 选择 PDF, or 选择文件夹. Those paths need the desktop dialog plugin.
- Creation starts a quiet bibliography lookup (`runPrepareMeta`). It may leave 作业运行中 in the status strip and may log network errors. The journey does not wait for that job and does not require a network.
- Do not fill a real arXiv id or DOI here. A hit can add metadata; the title stays, but the stage gets busier and the assertion gets brittle.
- 创建论文 stays in the current domain (多模态 on a fresh seed).
