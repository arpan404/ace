import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

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
 *
 * Plus a ratchet on the class rules of the app UX audit (X-1 to X-3), per file against
 * `scripts/ui-class-baseline.json`: literal type sizes (`text-[13px]`), literal radii
 * (`rounded-[10px]`), and an `outline-none` with no focus style back (`focus-ring`,
 * `focus-ring-inset`, or its own `focus-visible:` rule). A file may keep the count it had and
 * never gain one; a file not listed may have none. `--update` rewrites the baseline from the
 * tree, so migrating files tightens it.
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

// The X-1 to X-3 ratchet.
const baselinePath = "scripts/ui-class-baseline.json";
type Rule = "text-size" | "radius" | "bare-outline";
type Counts = Partial<Record<Rule, number>>;
/** Text drawn by its own renderer, where literal sizes are the point. */
const ratchetExempt = [/components\/gpu-text\//, /features\/thread\/items\/bubble/];
const ratchetFiles = files.filter(
  (path) =>
    /^apps\/web\/src\/(features|components|app)\//.test(path) &&
    !ratchetExempt.some((pattern) => pattern.test(path)),
);
const literalSize = /\btext-\[\d/g;
const literalRadius = /\brounded(?:-[trblse]{1,2})?-\[\d/g;
// One class list: a string literal on one line.
const classList = /"([^"\n]*)"|`([^`\n]*)`/g;

function countClasses(source: string): Counts {
  const counts: Counts = {};
  const add = (rule: Rule, n: number) => {
    if (n > 0) counts[rule] = (counts[rule] ?? 0) + n;
  };
  add("text-size", source.match(literalSize)?.length ?? 0);
  add("radius", source.match(literalRadius)?.length ?? 0);
  for (const match of source.matchAll(classList)) {
    const list = match[1] ?? match[2] ?? "";
    if (!/(^|\s)outline-none(\s|$)/.test(list)) continue;
    // Floating surfaces (popups, dialogs, positioners) hold focus for their items, not for show.
    if (/\b(glass|isolate|fixed)\b/.test(list)) continue;
    // The focus style may sit in the next string of the same class list (`cn(a, b)`).
    const near = source.slice(match.index, match.index + match[0].length + 400);
    if (/focus-ring|focus-visible:|focus:|focus-within:|data-highlighted:/.test(near)) continue;
    add("bare-outline", 1);
  }
  return counts;
}

const classCounts: Record<string, Counts> = {};
for (const path of ratchetFiles) {
  const counts = countClasses(readFileSync(path, "utf8"));
  if (Object.keys(counts).length) classCounts[path] = counts;
}

if (process.argv.includes("--update")) {
  const sorted = Object.fromEntries(
    Object.entries(classCounts).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  process.stdout.write(`Wrote ${baselinePath} (${Object.keys(sorted).length} files).\n`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, Counts>;
const advice: Record<Rule, string> = {
  "text-size": "use the type scale (text-2xs, text-xs, text-sm, text-ui, text-base, text-md…)",
  radius: "use the radius scale (rounded-xs, rounded-sm, rounded-md, rounded-card, rounded-lg…)",
  "bare-outline": "add focus-ring (controls) or focus-ring-inset (rows in scrollers)",
};
const ratchetFailures: string[] = [];
let tightened = 0;
for (const [path, counts] of Object.entries(classCounts))
  for (const [rule, n] of Object.entries(counts) as [Rule, number][]) {
    const allowed = baseline[path]?.[rule] ?? 0;
    if (n > allowed)
      ratchetFailures.push(`${path}: ${n} ${rule} (allowed ${allowed}); ${advice[rule]}`);
  }
for (const [path, counts] of Object.entries(baseline))
  for (const [rule, n] of Object.entries(counts) as [Rule, number][])
    if ((classCounts[path]?.[rule] ?? 0) < n) tightened++;

const print = (findings: Finding[], write: (text: string) => void) => {
  for (const { path, line, found, use } of findings) write(`${path}:${line}: ${found} → ${use}\n`);
};
print(advisory, (text) => process.stdout.write(`advisory: ${text}`));
print(enforced, (text) => process.stderr.write(text));
for (const failure of ratchetFailures) process.stderr.write(`${failure}\n`);
const failing = enforced.length + ratchetFailures.length + (strict ? advisory.length : 0);
process.stdout.write(
  `UI values: ${enforced.length} colour washes to rewrite, ${advisory.length} advisory pixel values in ${files.length} files.\n` +
    `UI classes: ${ratchetFailures.length} over the baseline in ${ratchetFiles.length} files` +
    (tightened ? `; ${tightened} counts fell, run with --update to tighten it.\n` : ".\n"),
);
if (failing > 0) process.exit(1);
