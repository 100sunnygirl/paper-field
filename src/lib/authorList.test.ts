import { describe, expect, it } from "vitest";
import { splitAuthorList } from "./authorList";

describe("splitAuthorList · 粘贴名单自动拆分", () => {
  it("逗号 / 顿号 / 分号 / 换行分隔都能拆开，顺序保持原文", () => {
    expect(splitAuthorList("张三、李四；王五\n赵六, Alice Smith")).toEqual([
      "张三",
      "李四",
      "王五",
      "赵六",
      "Alice Smith",
    ]);
  });

  it("剥掉编号前缀（1. / （2） / ③）与括注机构", () => {
    expect(splitAuthorList("1. Alice Smith (MIT)\n（2）Bob Lee（北大）\n③ Carol Wu")).toEqual([
      "Alice Smith",
      "Bob Lee",
      "Carol Wu",
    ]);
  });

  it("丢弃连接词与空段，保留姓名内的正常点号", () => {
    expect(splitAuthorList("Alice Smith, and, Bob Lee, , J. K. Rowling")).toEqual([
      "Alice Smith",
      "Bob Lee",
      "J. K. Rowling",
    ]);
  });

  it("arXiv 式脚注星号与结尾残余标点被去掉", () => {
    expect(splitAuthorList("Hao Liu*; Chunyuan Li†; Qingyang Wu,")).toEqual([
      "Hao Liu",
      "Chunyuan Li",
      "Qingyang Wu",
    ]);
  });

  it("全角数字与冒号编号（一、3：）拆分后可识别", () => {
    // NFKC 把全角数字折成半角；顿号/冒号前缀按分隔符或尾部标点处理
    expect(splitAuthorList("３. 全角编号\n4：冒号编号")).toEqual(["全角编号", "冒号编号"]);
  });

  it("识别不到姓名时返回空数组（调用方据此提示）", () => {
    expect(splitAuthorList("   \n and \n、；, ")).toEqual([]);
  });

  it("「Smith, J.」这类引文写法会拆成两行——已知启发式边界，由用户校对", () => {
    // 诚实记录边界行为：半角逗号是分隔符，姓前名后的写法必然拆开。
    expect(splitAuthorList("Smith, J.")).toEqual(["Smith", "J."]);
  });
});
