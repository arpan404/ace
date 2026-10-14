import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

const glassCss = readFileSync(join(import.meta.dirname, "glass.css"), "utf8");

/*
 * The floating material as the browser cascades it, on real elements. jsdom doesn't apply rules
 * inside `@layer`, so the layer wrapper is lifted off; nothing else changes.
 */

const unlayered = glassCss.replace(
  /@layer components \{([\s\S]*)\}\s*(@keyframes[\s\S]*)$/,
  "$1\n$2",
);

let style: HTMLStyleElement;
beforeEach(() => {
  style = document.createElement("style");
  style.textContent = unlayered;
  document.head.append(style);
});
afterEach(() => {
  style.remove();
  document.body.replaceChildren();
  for (const name of ["data-surface", "data-glass-engine"])
    document.documentElement.removeAttribute(name);
});

function setRoot(surface: "translucent" | "solid", engine: "liquid" | "blur") {
  document.documentElement.setAttribute("data-surface", surface);
  document.documentElement.setAttribute("data-glass-engine", engine);
}

/** A floating layer of `className`, and a second one inside it. */
function layers(className: string) {
  const outer = document.createElement("div");
  outer.className = className;
  const inner = document.createElement("div");
  inner.className = "ace-floating";
  outer.append(inner);
  document.body.append(outer);
  return { outer, inner };
}

const backdrop = (element: Element) =>
  getComputedStyle(element).getPropertyValue("backdrop-filter");
const blurs = (element: Element) => /blur\(/.test(backdrop(element));

test("glass frosts the backdrop under Translucent, and bends it after the blur on Chromium", () => {
  setRoot("translucent", "blur");
  expect(backdrop(layers("ace-floating").outer)).toMatch(
    /^blur\(.*\)\s+saturate\(.*\)\s+contrast\(.*\)\s+brightness\(.*\)$/s,
  );
  setRoot("translucent", "liquid");
  const { outer } = layers("ace-floating");
  outer.style.setProperty("--liquid-filter", "url(#rim)");
  // The rim filter comes last: it bends frosted colour at the edge, never sharp text.
  expect(backdrop(outer)).toMatch(/^blur\(.*\)\s+brightness\(.*\)\s+var\(--liquid-filter,\s*\)$/s);
});

test("Solid surfaces and reduced transparency render no backdrop filter on any layer", () => {
  for (const engine of ["liquid", "blur"] as const) {
    setRoot("solid", engine);
    for (const className of ["ace-floating", "glass", "ace-floating ace-modal", "ace-backdrop"]) {
      const { outer, inner } = layers(className);
      expect([className, engine, blurs(outer), blurs(inner)]).toEqual([
        className,
        engine,
        false,
        false,
      ]);
    }
  }
});

test("glass is never stacked: a floating layer inside a glass one renders solid", () => {
  for (const engine of ["liquid", "blur"] as const) {
    setRoot("translucent", engine);
    const { outer, inner } = layers("ace-floating");
    expect(blurs(outer)).toBe(true);
    expect(blurs(inner)).toBe(false);
    expect(getComputedStyle(inner).getPropertyValue("background")).toBe("var(--surface-2)");
  }
});

test("dialogs and tooltips are solid even under Translucent", () => {
  setRoot("translucent", "liquid");
  expect(blurs(layers("ace-floating-solid").outer)).toBe(false);
});

test("the command palette adds no blur over the backdrop that already blurred the page", () => {
  setRoot("translucent", "liquid");
  expect(blurs(layers("ace-backdrop").outer)).toBe(true);
  expect(blurs(layers("ace-floating ace-modal").outer)).toBe(false);
});
