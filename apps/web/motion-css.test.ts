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

/*
 * Nothing loops forever: an infinite animation keeps the compositor drawing frames for as long as
 * its element shows, which is idle CPU on the GPU and renderer. Live state is a still mark. Only
 * the startup mark's breath (while ace starts) and an indeterminate progress bar (during a
 * transfer it can't measure) may repeat, and each goes away when what it stands for ends.
 */
const mayLoop = /^(?::root\[data-reduce-motion\] )?\.(?:fx-breathe|fx-indeterminate)$/;

test("the production stylesheet loops no animation but the startup breath and indeterminate progress", () => {
  const theme = themeAnimations();
  const resolved = (value: string) =>
    value.replace(/var\((--animate-[\w-]+)\)/g, (call, name: string) => theme.get(name) ?? call);
  const looping = rules().filter(({ body }) => {
    const animation = animationOf(body);
    const count = /(?:^|;)\s*animation-iteration-count:([^;]+)/.exec(body)?.[1];
    return [animation, count].some((value) => value && /\binfinite\b/.test(resolved(value)));
  });
  // The two that may loop are in the build, so this reads real rules and not an empty list.
  expect(looping.length).toBeGreaterThan(0);
  const refused = looping.flatMap((rule) =>
    selectorsOf(rule.selector).filter((selector) => !mayLoop.test(selector)),
  );
  expect(refused).toEqual([]);
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
