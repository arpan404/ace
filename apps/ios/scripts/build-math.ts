import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Writes the phone's math page, `Resources/math.html`: the bundled `math/page.ts` (KaTeX and the
 * web's safety settings) and KaTeX's own stylesheet with its WOFF2 fonts inlined, so the page
 * needs nothing beyond itself and runs with every network request refused. Generated, never
 * committed:
 *
 *   bun scripts/build-math.ts
 */
const here = dirname(fileURLToPath(import.meta.url));
const katex = dirname(fileURLToPath(import.meta.resolve("katex/dist/katex.min.css")));
const built = await Bun.build({
  entrypoints: [join(here, "..", "math", "page.ts")],
  target: "browser",
  format: "iife",
  minify: true,
});
if (!built.success) throw new AggregateError(built.logs, "The math page didn't build");
const script = await built.outputs[0]?.text();
if (!script) throw new Error("The math page built nothing");

let css = await readFile(join(katex, "katex.min.css"), "utf8");
// Only WOFF2: every system the phone runs reads it, and the page stays a third of the size.
css = css.replace(/,url\(fonts\/[^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "");
const fonts = [
  ...new Set([...css.matchAll(/url\(fonts\/([^)]+\.woff2)\)/g)].map((match) => match[1])),
];
for (const font of fonts) {
  if (!font) continue;
  const data = (await readFile(join(katex, "fonts", font))).toString("base64");
  css = css.replaceAll(`url(fonts/${font})`, `url(data:font/woff2;base64,${data})`);
}

const page = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=2000, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>${css}
html,body{margin:0;padding:0;background:transparent}
#math{position:absolute;left:120px;top:120px;display:inline-block;color:#000;white-space:nowrap;line-height:1.2}
#math .katex-display{margin:0;overflow:visible}
#baseline{display:inline-block;width:0;height:0;vertical-align:baseline}
</style></head><body><div id="math"></div>
<script>${script}</script></body></html>`;
const target = join(here, "..", "Resources", "math.html");
await writeFile(target, page);
console.log(`Wrote the math page to ${target} (${Math.round(page.length / 1024)} KB)`);
