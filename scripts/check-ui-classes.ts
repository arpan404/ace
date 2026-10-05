import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * The web app's class rules (app UX audit X-1 to X-3), as a ratchet:
 * - type sizes come from the scale (`text-ui`, `text-sm`…), not `text-[13px]`;
 * - radii come from the scale (`rounded-md`, `rounded-card`…), not `rounded-[10px]`;
 * - a class list that removes the outline (`outline-none`) puts a focus style back
 *   (`focus-ring`, `focus-ring-inset`, or its own `focus-visible:` / `focus:` rule).
 *
 * Files listed in the baseline may keep the count they had; a file may never gain one, and a
 * file not listed may have none. `--update` rewrites the baseline from the tree (do this after
 * migrating files, so the ratchet tightens).
 */
const baselinePath = "scripts/ui-class-baseline.json";
const roots = ["apps/web/src/features", "apps/web/src/components", "apps/web/src/app"];
/** Text drawn by its own renderer, where literal sizes are the point. */
const exempt = [/components\/gpu-text\//, /\.test\.tsx?$/, /features\/thread\/items\/bubble/];

type Rule = "text-size" | "radius" | "bare-outline";
type Counts = Partial<Record<Rule, number>>;

const literalSize = /\btext-\[\d/g;
const literalRadius = /\brounded(?:-[trblse]{1,2})?-\[\d/g;
// One class list: a string literal on one line.
const classList = /"([^"\n]*)"|`([^`\n]*)`/g;

function count(source: string): Counts {
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

const files = execFileSync("git", ["ls-files", "-z", "--", ...roots], { encoding: "utf8" })
  .split("\0")
  .filter((path) => /\.tsx?$/.test(path) && !exempt.some((pattern) => pattern.test(path)));

const now: Record<string, Counts> = {};
for (const path of files) {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    continue; // Deleted in the working tree.
  }
  const counts = count(source);
  if (Object.keys(counts).length) now[path] = counts;
}

if (process.argv.includes("--update")) {
  const sorted = Object.fromEntries(Object.entries(now).toSorted(([a], [b]) => a.localeCompare(b)));
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
const failures: string[] = [];
let tightened = 0;
for (const [path, counts] of Object.entries(now))
  for (const [rule, n] of Object.entries(counts) as [Rule, number][]) {
    const allowed = baseline[path]?.[rule] ?? 0;
    if (n > allowed) failures.push(`${path}: ${n} ${rule} (allowed ${allowed}); ${advice[rule]}`);
  }
for (const [path, counts] of Object.entries(baseline))
  for (const [rule, n] of Object.entries(counts) as [Rule, number][])
    if ((now[path]?.[rule] ?? 0) < n) tightened++;

if (failures.length) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exit(1);
}
process.stdout.write(
  `UI classes: ${files.length} files within the baseline` +
    (tightened ? `; ${tightened} counts fell, run with --update to tighten it.\n` : ".\n"),
);
