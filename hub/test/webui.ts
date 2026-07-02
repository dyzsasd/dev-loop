// Web-UI design-system + markdown-renderer guards. The STYLE token sheet and the esc-first markdown
// renderer are the two pieces most likely to regress silently (a hardcoded hex that fails dark-mode AA;
// a link/fence rule that drops content or admits a javascript: href).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "../src/daemonviews.ts";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "daemonviews.ts"), "utf8");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── 1. Design tokens: no raw hex outside the :root token blocks — every color must be a var() ──
// Isolate the STYLE template literal, drop the two :root{...} blocks (where the tokens are DEFINED),
// then assert no #rrggbb / #rgb remains (an accent that skips a token can't adapt to dark mode).
const style = src.slice(src.indexOf("const STYLE = `") + 14, src.indexOf("`;\n\nexport function page"));
const styleNoRoot = style.replace(/:root\{[^}]*\}/g, "").replace(/@media\(prefers-color-scheme:dark\)\{:root\{[^}]*\}\}/g, "");
const strayHex = [...styleNoRoot.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
ok(strayHex.length === 0, `no raw hex outside :root token blocks (design tokens are the single color source)${strayHex.length ? " — stray: " + strayHex.join(", ") : ""}`);
ok(/--c-feature:/.test(style) && /--c-bug:/.test(style) && /prefers-color-scheme:dark/.test(style),
  "semantic accent tokens exist with a dark-mode override block");
ok(/--font-mono:/.test(style) && !/ui-monospace,SFMono-Regular,Menlo,monospace/.test(styleNoRoot),
  "the mono font stack is a token (--font-mono), not repeated verbatim across rules");

// ── 2. Markdown: fenced code blocks ──
const fence = renderMarkdown("before\n```\nconst x = 1;\n- not a list\n```\nafter");
ok(/<pre><code>const x = 1;\n- not a list<\/code><\/pre>/.test(fence), "``` fence → one <pre><code>, inline transforms suspended (dash is NOT a list item inside)");
ok(!/<p>```<\/p>/.test(fence), "the ``` marker lines are consumed, never rendered as literal <p>```</p>");
ok(/<p>before<\/p>/.test(fence) && /<p>after<\/p>/.test(fence), "text around the fence still renders");

// ── 3. Markdown: links (allowlisted) ──
ok(/<a href="https:\/\/x\.com\/a" rel="noopener noreferrer" target="_blank">text<\/a>/.test(renderMarkdown("[text](https://x.com/a)")), "[text](https url) → an allowlisted link");
ok(/<a href="\/ticket\/DL-1"[^>]*>see<\/a>/.test(renderMarkdown("[see](/ticket/DL-1)")), "[text](/same-site path) → an allowlisted link");
const bare = renderMarkdown("visit https://example.com/p now");
ok(/<a href="https:\/\/example\.com\/p"[^>]*>https:\/\/example\.com\/p<\/a>/.test(bare), "a bare https URL autolinks");
// XSS: a javascript: (or other non-http/non-path) href must render as inert text, never an <a>
const evil = renderMarkdown("[x](javascript:alert(1))");
ok(!/<a /.test(evil) && /javascript/.test(evil), "javascript: href is rejected → inert text, no <a> (esc-first + allowlist)");
ok(!/<a /.test(renderMarkdown("[x](data:text/html,<script>)")), "data: href is rejected too");

// ── 4. Markdown: emphasis, blockquote, and no raw HTML injection ──
ok(/<blockquote>quoted<\/blockquote>/.test(renderMarkdown("> quoted")), "> line → blockquote");
ok(/<em>i<\/em>/.test(renderMarkdown("an *i* word")), "*italic* → <em>");
ok(!/<script>/.test(renderMarkdown("<script>alert(1)</script>")), "raw HTML in source is escaped, never emitted as a tag");

console.log(fails === 0 ? "\nWEBUI_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
