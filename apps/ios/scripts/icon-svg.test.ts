import { ArrowUpIcon, BellSlashIcon, CheckIcon, FolderPlusIcon } from "@ace/icons";
import { expect, test } from "vitest";
import { assetSvg, clippedSvg } from "./icon-svg.ts";

/** Every `clip-path` an element points at, and the clip each one names. */
function clipsOf(svg: string) {
  const used = [...svg.matchAll(/clip-path="url\(#([^)]+)\)"/g)].map((m) => m[1]);
  const defined = new Map(
    [...svg.matchAll(/<clipPath id="([^"]+)"><path clip-rule="evenodd" d="([^"]+)">/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  return { used, defined };
}

/** What an `<svg>` draws, inside its own element. */
const inner = (svg: string) => svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));

/** An icon whose one mask holds `cut`. */
const masked = (cut: string) =>
  `<svg><defs><mask id="m"><rect width="24" height="24" fill="white"></rect>${cut}</mask></defs><g mask="url(#m)"></g></svg>`;

test("an off icon's gap beside its slash is clipped out, with no mask left for iOS to rasterise", () => {
  const svg = assetSvg(BellSlashIcon, "regular");
  expect(svg).not.toContain("<mask");
  const { used, defined } = clipsOf(svg);
  expect(used.length).toBeGreaterThan(0);
  for (const id of used) {
    // The whole box, less a round-capped band along the slash.
    expect(defined.get(id ?? "")).toMatch(/^M0 0H24V24H0ZM[^Z]+A[^Z]+A[^Z]+Z$/);
  }
});

test("a new-item icon's hole under its plus is clipped out as a circle", () => {
  const { used, defined } = clipsOf(assetSvg(FolderPlusIcon, "regular"));
  expect(used.length).toBeGreaterThan(0);
  // Centred on the plus at 18, 18: from x 11.65 round to x 24.35.
  for (const id of used)
    expect(defined.get(id ?? "")).toContain("M11.65 18A6.35 6.35 0 1 0 24.35 18");
});

test("bold draws a heavier stroke than regular from the same drawing", () => {
  expect(assetSvg(CheckIcon, "regular")).toContain('stroke-width="1.75"');
  expect(assetSvg(CheckIcon, "bold")).toContain('stroke-width="2.25"');
});

test("a turned icon draws the set's drawing rotated about the box's centre", () => {
  const up = assetSvg(ArrowUpIcon, "regular");
  const down = assetSvg(ArrowUpIcon, "regular", 180);
  expect(inner(down)).toBe(`<g transform="rotate(180 12 12)">${inner(up)}</g>`);
});

test("a mask cut the iPhone can't clip stops the generator instead of drawing it wrong", () => {
  expect(() =>
    clippedSvg(masked('<rect x="1" y="1" width="4" height="4" fill="black"></rect>')),
  ).toThrow();
  expect(() =>
    clippedSvg(
      masked(
        '<circle cx="1" cy="1" r="1" fill="black"></circle><circle cx="5" cy="5" r="1" fill="black"></circle>',
      ),
    ),
  ).toThrow(/exactly one cut/);
});
