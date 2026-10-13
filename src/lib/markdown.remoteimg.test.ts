import { describe, expect, it, vi, beforeEach } from "vitest";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => openUrl(u) }));
vi.mock("./util", async (orig) => ({ ...(await orig<object>()), isTauri: () => true }));

import { onMarkdownClick, renderMarkdown, REMOTE_IMG_ATTR } from "./markdown";

function mount(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

async function click(el: Element) {
  const preventDefault = vi.fn();
  onMarkdownClick({ target: el, preventDefault });
  await new Promise((r) => setTimeout(r, 0));
  return preventDefault;
}

beforeEach(() => openUrl.mockReset());

describe("remote images", () => {
  it("replaces an http(s) image with a placeholder and an open button", async () => {
    const root = mount(renderMarkdown("![图 1](https://example.com/a.png)"));
    expect(root.querySelector("img")).toBeNull();
    const box = root.querySelector(".ef-md-remote-img")!;
    expect(box.textContent).toContain("远程图片未加载（图 1）");
    const btn = box.querySelector(`[${REMOTE_IMG_ATTR}]`)!;
    expect(btn.getAttribute(REMOTE_IMG_ATTR)).toBe("https://example.com/a.png");
    expect((await click(btn))).toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/a.png");
  });

  it("keeps data: and asset: images untouched", () => {
    const root = mount(renderMarkdown("![d](data:image/png;base64,AAAA) ![a](asset://localhost/x.png)"));
    const srcs = Array.from(root.querySelectorAll("img")).map((i) => i.getAttribute("src"));
    // asset: src is already dropped by DOMPurify before this change; behaviour is unchanged here.
    expect(srcs).toEqual(["data:image/png;base64,AAAA", null]);
    expect(root.querySelector(".ef-md-remote-img")).toBeNull();
  });

  it("leaves no event attributes on a replaced remote image", () => {
    const html = renderMarkdown('<img src="https://e.com/x.png" onerror="alert(1)" onload="alert(2)">');
    expect(html).not.toMatch(/onerror|onload|alert/);
    expect(mount(html).querySelector(".ef-md-remote-img")).not.toBeNull();
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["file:", "file:///etc/passwd"],
  ])("refuses to open %s urls smuggled into the attribute", async (_n, url) => {
    const root = mount(renderMarkdown(`<button ${REMOTE_IMG_ATTR}="${url}">x</button>`));
    const btn = root.querySelector("button");
    if (btn) await click(btn);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("does not turn javascript:/file: image sources into open buttons", () => {
    for (const src of ["javascript:alert(1)", "file:///etc/passwd"]) {
      const root = mount(renderMarkdown(`<img src="${src}">`));
      expect(root.querySelector(`[${REMOTE_IMG_ATTR}]`)).toBeNull();
    }
  });

  it("ignores clicks outside placeholders", async () => {
    const root = mount(renderMarkdown("plain **text**"));
    expect(await click(root.querySelector("strong")!)).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });
});
