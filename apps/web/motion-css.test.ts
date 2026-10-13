import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";
import { beforeAll, expect, test } from "vitest";
import { cssWithoutLegacyPolyfills } from "./css-polyfills.ts";

/*
 * The production stylesheet, built the way `vite build` builds it (Tailwind scanning the app's
 * source, the polyfill strip, minification), checked for the animations it actually ships.
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
  selector.includes("data-reduce-motion") || selector.includes("data-connection");

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

test("live indicators and every animate-* utility the app uses animate unless motion is reduced", () => {
  const classes = [
    ...animateUtilities(),
    "spin-ring",
    "fx-spin-slow",
    "fx-walk",
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
