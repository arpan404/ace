import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";
import { beforeAll, expect, test } from "vitest";
import { cssWithoutLegacyPolyfills } from "./css-polyfills.ts";

/*
 * The production stylesheet, built the way `vite build` builds it (Tailwind scanning the app's
 * source, the polyfill strip, minification), checked for the animations it actually ships and
 * for the backdrop filters it can apply.
 */

const root = import.meta.dirname;
let css = "";

beforeAll(async () => {
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [tailwindcss(), cssWithoutLegacyPolyfills()],
    build: {
      write: false,
      rolldownOptions: { input: join(root, "src/styles/index.css") },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((built) =>
    "output" in built ? built.output : [],
  );
  css = outputs
    .flatMap((file) =>
      file.type === "asset" && file.fileName.endsWith(".css") ? [String(file.source)] : [],
    )
    .join("\n");
}, 120_000);

const keywords = new Set(
  "none infinite linear ease ease-in ease-out ease-in-out both forwards backwards alternate alternate-reverse normal reverse running paused step-start step-end initial inherit unset".split(
    " ",
  ),
);

/** Strips function calls (`var(…)`, `calc(…)`, `cubic-bezier(…)`, `linear(…)`), innermost first. */
function withoutCalls(value: string): string {
  let out = value;
  for (let previous = ""; previous !== out;) {
    previous = out;
    out = out.replace(/[\w-]*\([^()]*\)/g, " ");
  }
  return out;
}

/** The keyframe names an `animation` value plays, resolving `var(--animate-*)` theme values. */
function namesIn(value: string, themeAnimations: ReadonlyMap<string, string>): string[] {
  const variable = /^var\((--animate-[\w-]+)\)$/.exec(value.trim());
  if (variable?.[1]) return namesIn(themeAnimations.get(variable[1]) ?? "", themeAnimations);
  return [...withoutCalls(value).matchAll(/(?<![\w.-])[a-z][\w-]*/g)]
    .map(([name]) => name)
    .filter((name) => !keywords.has(name));
}

interface Rule {
  selector: string;
  body: string;
}

function rules(): Rule[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector = "", body = ""]) => ({
    selector: selector.trim(),
    body,
  }));
}

const keyframes = () => new Set([...css.matchAll(/@keyframes ([\w-]+)/g)].map(([, name]) => name));
const themeAnimations = () =>
  new Map(
    [...css.matchAll(/(--animate-[\w-]+):([^;}]+)/g)].map(([, name = "", value = ""]) => [
      name,
      value,
    ]),
  );
const animationOf = (body: string) =>
  /(?:^|;)\s*animation(?:-name)?:([^;]+)/.exec(body)?.[1]?.replace("!important", "");
const reducedOnly = (selector: string) =>
  selector.includes("data-reduce-motion") || selector.includes("data-live-held");

/** Every `animate-<name>` utility class written in the app's runtime source. */
function animateUtilities(): string[] {
  const used = new Set<string>();
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
        for (const [, name] of readFileSync(path, "utf8").matchAll(
          /(?<![\w-])animate-([a-z][\w-]*)/g,
        ))
          if (name) used.add(name);
    }
  };
  walk(join(root, "src"));
  return [...used].map((name) => `animate-${name}`);
}

test("every animation the production stylesheet plays has its keyframes", () => {
  const defined = keyframes();
  const theme = themeAnimations();
  const missing = rules().flatMap((rule) => {
    const value = animationOf(rule.body);
    if (!value) return [];
    return namesIn(value, theme)
      .filter((name) => !defined.has(name))
      .map((name) => `${rule.selector}: ${name}`);
  });
  expect(missing).toEqual([]);
});

test("reduced motion keeps every live indicator animating, so loading never looks hung", () => {
  const live = ["spin-ring", "aperture-part", "fx-breathe", "fx-indeterminate", "animate-pulse"];
  const defined = keyframes();
  const theme = themeAnimations();
  const stopped = rules().flatMap(({ selector, body }) => {
    const value = animationOf(body);
    if (value === undefined || !selector.includes("data-reduce-motion")) return [];
    if (namesIn(value, theme).some((name) => defined.has(name))) return [];
    return live
      .filter((name) => new RegExp(`\\.${name}(?![\\w-])`).test(selector))
      .map((name) => `.${name} stops under ${selector}`);
  });
  expect(stopped).toEqual([]);
});

test("live indicators and every animate-* utility the app uses animate unless motion is reduced", () => {
  const classes = [
    ...animateUtilities(),
    "spin-ring",
    "aperture-part",
    "fx-breathe",
    "fx-indeterminate",
  ];
  expect(classes).toContain("animate-pulse");
  const defined = keyframes();
  const theme = themeAnimations();
  const problems = classes.flatMap((name) => {
    const mentions = rules().filter((rule) =>
      rule.selector
        .split(",")
        .some((selector) => new RegExp(`\\.${name}(?![\\w-])`).test(selector)),
    );
    const plays = mentions.some((rule) => {
      const value = animationOf(rule.body);
      if (!value || reducedOnly(rule.selector)) return false;
      const names = namesIn(value, theme);
      return names.length > 0 && names.every((keyframe) => defined.has(keyframe));
    });
    const found = plays ? [] : [`.${name} plays no animation with keyframes`];
    for (const rule of mentions)
      if (animationOf(rule.body)?.trim().startsWith("none") && !reducedOnly(rule.selector))
        found.push(`.${name} is stopped outside reduced motion by ${rule.selector}`);
    return found;
  });
  expect(problems).toEqual([]);
});

/** A selector list split at its top-level commas, so `:is(.a, .b)` stays one selector. */
function selectorsOf(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const char = list[i];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out;
}

test("under Solid surfaces or reduced transparency nothing the stylesheet ships blurs or bends the backdrop", () => {
  const filtering = rules().filter((rule) => {
    const value = /(?:^|;)\s*(?:-webkit-)?backdrop-filter:([^;]*)/.exec(rule.body)?.[1]?.trim();
    if (!value || /^none\b/.test(value)) return false;
    // Tailwind's bare `.backdrop-filter` composes `--tw-backdrop-*` values that only another
    // backdrop utility sets: on its own it filters nothing. A utility that sets one is caught.
    const composedOnly = /^(?:var\(--tw-backdrop-[\w-]+,\)\s*)+$/.test(value);
    return !composedOnly || /--tw-backdrop-[\w-]+:/.test(rule.body);
  });
  // The glass itself is in the build, so this checks real rules and not an empty list.
  expect(filtering.length).toBeGreaterThan(0);
  // `data-surface` is "solid" under the Solid setting, reduced transparency and Signal, so a
  // selector that needs it to be "translucent" can't match then.
  const unguarded = filtering.flatMap((rule) =>
    selectorsOf(rule.selector).filter(
      (selector) => !/\[data-surface=(["']?)translucent\1\]/.test(selector),
    ),
  );
  expect(unguarded).toEqual([]);
});
