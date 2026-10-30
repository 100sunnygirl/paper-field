/**
 * 粘贴整段作者名单 → 拆分为逐个姓名（编辑论文对话框的作者校对入口）。
 *
 * 输入通常来自 PDF 复制：换行 / 逗号 / 分号 / 顿号分隔，可能带 "1." "（2）" "①"
 * 之类的编号前缀与 "（机构）" 括注。拆分只做诚实的启发式：
 *  - 半角逗号同样按分隔符处理（英文名单最常见的 "A. Smith, B. Lee" 写法）；
 *    因此「Smith, J.」这类姓前名后的引文写法会被拆成两行——界面提示用户拆分后逐项校对。
 *  - 括注（机构 / 脚注星号）截掉不进姓名，机构留待逐项补填。
 */

/** 编号前缀：`1.` `1)` `1、` `1：` `（3）` `[4]`（NFKC 后全角数字与带圈数字都已折成半角数字）。 */
const NUMBER_PREFIX = /^(?:\(?\d{1,3}\s*[).、：:]\s*|[\[（【]\d{1,3}[\]））】]\s*)/u;

/** 单独出现的连接词不是姓名。 */
const CONNECTIVE = /^(?:and|et\s+al\.?|&|和|与|以及)$/i;

/** 截掉姓名里的括注起点（半角 / 全角括号）。 */
const PAREN_START = /[（(]/;

/** 姓名尾部的脚注符号与残余标点（不含句点：单字母缩写「J.」要保住那个点）。 */
const TRAILING_MARKS = /(?:[*†‡§¶#]+|[,;:、，；：])+$/;

/** 带圈数字编号（①…⑳）：NFKC 会把它们折成裸数字，先在折行前剥掉。 */
const CIRCLED_PREFIX = /^[①-⑳]\s*/u;

/**
 * 把一段作者名单拆成姓名数组；识别不到任何姓名时返回空数组（调用方据此提示）。
 * 顺序保持原文顺序（第一作者仍排第一）。
 */
export function splitAuthorList(raw: string): string[] {
  const text = raw.replace(/\r/g, "");
  const names: string[] = [];
  for (const piece of text.split(/[\n,，;；、]+/)) {
    let name = piece
      .replace(CIRCLED_PREFIX, "")
      .normalize("NFKC")
      .replace(/[\u00a0\u3000]/g, " ")
      .trim();
    name = name.replace(NUMBER_PREFIX, "").trim();
    const paren = name.search(PAREN_START);
    if (paren > 0) name = name.slice(0, paren);
    name = name.replace(TRAILING_MARKS, "").trim();
    if (!name || CONNECTIVE.test(name)) continue;
    names.push(name);
  }
  return names;
}
