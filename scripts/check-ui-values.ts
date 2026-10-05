import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/*
 * Keeps one-off Tailwind values from creeping back into the web CSS budget. Every distinct
 * arbitrary value is a rule of its own with a long escaped selector, so a value that already has a
 * token should use it and share the rule.
 *
 * - Enforced: `bg-[color-mix(in_oklab,var(--ring)_8%,transparent)]` where `--color-ring` is a theme
 *   colour; write `bg-ring/8`, which is the same CSS under a shorter, shared class.
 * - Advisory (`--strict` enforces): pixel values that equal a theme text size or radius, or a
 *   half step of the spacing scale (`h-[18px]` is `h-4.5`). A text token sets its line height
 *   too, so check the result. Prefer a nearby value that is already in use over adding a new one.
 *
 * Inline `style={}` is not a way around this: it costs the same bytes in JavaScript instead.
 */

const strict = process.argv.includes("--strict");
const theme = readFileSync("apps/web/src/styles/index.css", "utf8");
const colors = new Set([...theme.matchAll(/--color-([\w-]+):/g)].map((match) => match[1]));
const tokens = (prefix: string) =>
  new Map(
    [...theme.matchAll(new RegExp(`--${prefix}-([\\w-]+):\\s*([\\d.]+px);`, "g"))].map(
      (match) => [match[2], match[1]] as const,
    ),
  );
const textSizes = tokens("text");
const radii = tokens("radius");
const spacing = new Set(
  "p px py pt pb pl pr ps pe m mx my mt mb ml mr ms me gap gap-x gap-y w h size min-w min-h max-w max-h top right bottom left inset inset-x inset-y space-x space-y".split(
    " ",
  ),
);

const files = execFileSync(
  "git",
  ["ls-files", "-z", "--", "apps/web/src/*.ts", "apps/web/src/*.tsx", "packages/ui-core/src/*.ts"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter((path) => path && !/\.(test|gen)\.tsx?$/.test(path) && !path.includes("/test/"));

type Finding = { path: string; line: number; found: string; use: string };
const enforced: Finding[] = [];
const advisory: Finding[] = [];
const colorMix =
  /(?<![\w-])((?:[\w-]+:)*-?[a-z]+(?:-[a-z]+)*)-\[color-mix\(in_oklab,var\(--([\w-]+)\)_(\d+(?:\.\d+)?)%,transparent\)\]/g;
const pixels = /(?<![\w-[])((?:[\w-]+:)*)(-?)([a-z]+(?:-[a-z]+)*)-\[(\d+(?:\.\d+)?)px\]/g;

for (const path of files) {
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((text, index) => {
    const line = index + 1;
    for (const [found, utility, color, amount] of text.matchAll(colorMix))
      if (color && colors.has(color))
        enforced.push({ path, line, found, use: `${utility}-${color}/${amount}` });
    for (const [found, variants, minus, utility, value] of text.matchAll(pixels)) {
      if (!utility || !value) continue;
      const px = Number(value);
      const name =
        utility === "text"
          ? textSizes.get(`${value}px`)
          : utility.startsWith("rounded")
            ? radii.get(`${value}px`)
            : spacing.has(utility) && px % 2 === 0
              ? String(px / 4)
              : undefined;
      if (name) advisory.push({ path, line, found, use: `${variants}${minus}${utility}-${name}` });
    }
  });
}

const print = (findings: Finding[], write: (text: string) => void) => {
  for (const { path, line, found, use } of findings) write(`${path}:${line}: ${found} → ${use}\n`);
};
print(advisory, (text) => process.stdout.write(`advisory: ${text}`));
print(enforced, (text) => process.stderr.write(text));
const failing = enforced.length + (strict ? advisory.length : 0);
process.stdout.write(
  `UI values: ${enforced.length} colour washes to rewrite, ${advisory.length} advisory pixel values in ${files.length} files.\n`,
);
if (failing > 0) process.exit(1);
