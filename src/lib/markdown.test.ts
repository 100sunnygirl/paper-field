import { afterEach, describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

/**
 * 缺陷 2 回归：消毒层是 XSS 的主防线（README 安全小节同源）。
 * 断言各类注入载荷在渲染后：无 on* 事件属性、无 javascript: 链接、
 * 无 iframe/script/style/object/embed/form 存活；正常 GFM 不受影响。
 */

function mount(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

const FORBIDDEN_TAG = /<(iframe|script|style|object|embed|form)\b/i;
const EVENT_ATTR = /\son\w+\s*=/i;

describe("renderMarkdown XSS 回归", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each([
    ["无引号 img onerror", '<img src=x onerror=alert(1)>'],
    ["单引号 img onerror", "<img src=x onerror='alert(1)'>"],
    ["双引号 img onerror", '<img src=x onerror="alert(1)">'],
    ["大写 img onload", '<img src=x OnLoAd="alert(1)">'],
  ])("拦截 %s", (_name, payload) => {
    const html = renderMarkdown(payload);
    expect(html).not.toMatch(EVENT_ATTR);
    const container = mount(html);
    for (const img of Array.from(container.querySelectorAll("img"))) {
      for (const attr of Array.from(img.attributes)) {
        expect(attr.name.toLowerCase().startsWith("on")).toBe(false);
      }
    }
    // img 标签本身合法保留（src 仍在），只剥事件属性。
    expect(container.querySelector("img")?.getAttribute("src")).toBe("x");
  });

  it.each([
    ["javascript: 链接", "[x](javascript:alert(1))"],
    ["javaScript 混合大小写链接", "[x](JavaScript:alert(1))"],
    ["带空格绕过的 javascript 链接", "[x](javascript&#58;alert(1))"],
  ])("拦截 %s", (_name, payload) => {
    const html = renderMarkdown(payload);
    expect(html).not.toMatch(/javascript\s*:/i);
    const container = mount(html);
    for (const link of Array.from(container.querySelectorAll("a"))) {
      const href = link.getAttribute("href") ?? "";
      expect(href.toLowerCase().trim().startsWith("javascript:")).toBe(false);
    }
  });

  it.each([
    ["iframe", '<iframe src="https://evil.example"></iframe>'],
    ["script", "<script>alert(1)</script>"],
    ["style", "<style>body{background:red}</style>"],
    ["object", '<object data="https://evil.example/x.swf"></object>'],
    ["embed", '<embed src="https://evil.example/x.svg">'],
    ["form", '<form action="https://evil.example"><input name="pw"></form>'],
  ])("清除 %s 标签", (_name, payload) => {
    const html = renderMarkdown(payload);
    expect(html).not.toMatch(FORBIDDEN_TAG);
    const container = mount(html);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("style")).toBeNull();
    expect(container.querySelector("object")).toBeNull();
    expect(container.querySelector("embed")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
  });

  it("style 属性同样被剥（FORBID_ATTR）", () => {
    const html = renderMarkdown('<div style="background:url(javascript:alert(1))">x</div>');
    expect(html).not.toMatch(EVENT_ATTR);
    const container = mount(html);
    for (const el of Array.from(container.querySelectorAll("*"))) {
      expect(el.getAttribute("style")).toBeNull();
    }
  });

  it("空输入返回空字符串", () => {
    expect(renderMarkdown("")).toBe("");
  });
});

describe("renderMarkdown 正常 GFM 输出", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("表格正常渲染", () => {
    const html = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    const container = mount(html);
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll("th")).toHaveLength(2);
    expect(table?.querySelectorAll("td")).toHaveLength(2);
  });

  it("列表正常渲染", () => {
    const html = renderMarkdown("- 甲\n- 乙\n- 丙");
    const container = mount(html);
    expect(container.querySelectorAll("ul > li")).toHaveLength(3);
  });

  it("代码块正常渲染且内容不被吞", () => {
    const html = renderMarkdown("```js\nconst x = '<img src=x onerror=alert(1)>';\n```");
    const container = mount(html);
    const code = container.querySelector("pre > code");
    expect(code).not.toBeNull();
    // 代码块里的尖括号按文本处理：内容仍可见，但不产生真实 img 元素。
    expect(code?.textContent).toContain("img src=x");
    expect(container.querySelector("img")).toBeNull();
  });

  it("普通链接与图片保留", () => {
    const html = renderMarkdown("[官网](https://example.com/a?b=1)");
    const container = mount(html);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/a?b=1");
    expect(link?.textContent).toBe("官网");
  });
});
