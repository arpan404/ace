/**
 * Writes a close-up page of chosen icons: each at 64 px in outline, two-tone, solid and bold,
 * then at 14, 16 and 20 px. `bun sheet/write-zoom.ts <out.html> Bell BellSlash …` (names without
 * the `Icon` suffix). For checking drawings by eye while making them.
 */
import { writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as icons from "../src/index.ts";
import type { Icon, IconWeight } from "../src/glyph.ts";

const [out = "icon-zoom.html", ...names] = process.argv.slice(2);
const table: Record<string, unknown> = icons;
let tile = 0;
const draw = (icon: Icon, size: number, weight: IconWeight) =>
  renderToStaticMarkup(createElement(icon, { size, weight }), { identifierPrefix: `z${tile++}-` });

const rows = names.map((name) => {
  const icon = table[`${name}Icon`];
  if (typeof icon !== "function") return `<p>No icon called ${name}.</p>`;
  const glyph = icon as Icon;
  const big = (["regular", "duotone", "fill", "bold"] as const)
    .map((w) => draw(glyph, 64, w))
    .join("");
  const small = [14, 16, 20].map((s) => draw(glyph, s, "regular")).join("");
  return `<div class="r"><span class="n">${name}</span>${big}${small}</div>`;
});
writeFileSync(
  out,
  `<style>.z{display:grid;gap:12px;color:var(--foreground,#e8e8e8)}.r{display:flex;gap:14px;align-items:center;flex-wrap:wrap}.n{width:170px;font:12px var(--font-mono,monospace);color:var(--muted-foreground,#999)}svg{display:block}</style><div class="z">${rows.join("")}</div>`,
);
console.log(`${names.length} icons → ${out}`);
