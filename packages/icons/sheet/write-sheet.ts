/**
 * Writes a contact sheet of every icon in every weight and at row sizes, for reviewing the set
 * by eye: `bun run --filter @ace/icons sheet <out.html>`. The page uses the host's theme
 * variables when it has them (ace's chat renders it themed) and plain greys otherwise.
 */
import { writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as icons from "../src/index.ts";
import type { Icon, IconWeight } from "../src/glyph.ts";

const out = process.argv[2] ?? "icon-sheet.html";
const entries = Object.entries(icons)
  .filter((entry): entry is [string, Icon] => entry[0].endsWith("Icon"))
  .toSorted(([a], [b]) => a.localeCompare(b));
// Each tile renders on its own, so each gets its own id prefix to keep its masks apart.
let tile = 0;
const draw = (icon: Icon, size: number, weight: IconWeight) =>
  renderToStaticMarkup(createElement(icon, { size, weight, "aria-hidden": true }), {
    identifierPrefix: `t${tile++}-`,
  });

const tiles = entries
  .map(
    ([name, icon]) =>
      `<li><span class="w">${(["regular", "duotone", "fill"] as const).map((w) => draw(icon, 28, w)).join("")}</span>` +
      `<span class="s">${[14, 16, 20].map((s) => draw(icon, s, "regular")).join("")}</span>` +
      `<span class="n">${name.replace(/Icon$/, "")}</span></li>`,
  )
  .join("");

writeFileSync(
  out,
  `<style>
.sheet{--ink:var(--foreground,#e8e8e8);--meta:var(--muted-foreground,#9a9a9a);--rule:var(--border,#2a2a2a)}
.sheet p{font-size:13px;color:var(--meta);margin:0 0 12px}
.sheet ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,150px),1fr));border-top:1px solid var(--rule)}
.sheet li{display:grid;gap:8px;padding:12px 8px;border-bottom:1px solid var(--rule);min-width:0}
.sheet .w,.sheet .s{display:flex;gap:8px;align-items:center;color:var(--ink)}
.sheet .n{font:12px var(--font-mono,ui-monospace,monospace);color:var(--meta);overflow-wrap:anywhere}
.sheet svg{display:block;flex:none}
</style><div class="sheet"><p>${entries.length} icons. Each: outline, two-tone, solid at 28 px, then outline at 14, 16 and 20 px.</p><ul>${tiles}</ul></div>`,
);
console.log(`${entries.length} icons → ${out}`);
