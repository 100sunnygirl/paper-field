import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(source: string): string {
  const html = marked.parse(source || "") as string;
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "");
}
