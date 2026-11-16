/**
 * Rewrites `src/index.ts` from the glyph modules: every `export const …Icon` in
 * `src/glyphs/*.ts`, sorted. `bun run --filter @ace/icons index` after adding a glyph.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "src");
const exports = readdirSync(join(root, "glyphs"))
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .flatMap((file) =>
    [
      ...readFileSync(join(root, "glyphs", file), "utf8").matchAll(/^export const (\w+Icon)\b/gm),
    ].map((match) => ({ name: match[1] ?? "", file })),
  )
  .toSorted((a, b) => a.name.localeCompare(b.name));

writeFileSync(
  join(root, "index.ts"),
  `/** ace's icons, one module each so a page loads only the ones it draws. Written by sheet/write-index.ts. */\n` +
    `export { glyph, type Icon, type IconProps, type IconWeight } from "./glyph.ts";\n` +
    `export { circle, detail, dot, line, plussed, shape, slashed, spot, type Part } from "./parts.ts";\n` +
    exports.map(({ name, file }) => `export { ${name} } from "./glyphs/${file}";\n`).join(""),
);
console.log(`${exports.length} icons in src/index.ts`);
