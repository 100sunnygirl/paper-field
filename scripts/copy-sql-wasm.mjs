import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const vendorDir = path.join(process.cwd(), "public", "vendor");
const sourceDir = path.join(process.cwd(), "node_modules", "sql.js", "dist");

await mkdir(vendorDir, { recursive: true });
const javascriptSource = path.join(sourceDir, "sql-wasm.js");
const javascriptTarget = path.join(vendorDir, "sql-wasm.js");
// npm may extract text packages with CRLF on Windows; keep the vendored file stable in git.
const javascript = (await readFile(javascriptSource, "utf8")).replace(/\r\n/g, "\n");
await writeFile(javascriptTarget, javascript, "utf8");
await copyFile(path.join(sourceDir, "sql-wasm.wasm"), path.join(vendorDir, "sql-wasm.wasm"));
