import { expect, test } from "vitest";
import { accentIds, type AccentChoice } from "./accent.ts";
import { statusDistance } from "./accent-fit.ts";
import { contrastRatio, deltaE, parseOpaqueColor } from "./colour.ts";
import { themeDeclarations } from "./css.ts";
import { themeIds, type Scheme } from "./palettes.ts";

/*
 * The theme proposal's contrast tables, checked on what the page actually receives: every theme
 * in light and dark, read from its declared CSS tokens.
 */

const schemes: readonly Scheme[] = ["light", "dark"];
const rgb = (value: string | undefined) => {
  const parsed = parseOpaqueColor(value);
  if (!parsed) throw new Error(`not an opaque colour: ${value}`);
  return parsed;
};
const ratio = (a: string | undefined, b: string | undefined) => contrastRatio(rgb(a), rgb(b));

/** Page, sidebar, cards, floating layers, hover, active and code: where text is drawn. */
const surfaces = [
  "--background",
  "--sidebar",
  "--surface-1",
  "--surface-2",
  "--hover",
  "--active",
  "--code",
];
const text = ["--foreground", "--muted-foreground", "--subtle-foreground", "--ring-text"];
const statusWords = [
  "--status-working-text",
  "--status-needs-you-text",
  "--status-done-text",
  "--status-failed-text",
];
const statusMarks = ["--status-working", "--status-needs-you", "--status-done", "--status-failed"];

/** Readings below `minimum`, as "token on surface ratio" lines, so a failure names them. */
function below(
  tokens: Record<string, string>,
  colours: readonly string[],
  on: readonly string[],
  minimum: number,
): string[] {
  return colours.flatMap((colour) =>
    on.flatMap((surface) => {
      const value = ratio(tokens[colour], tokens[surface]);
      return value < minimum ? [`${colour} on ${surface} ${value.toFixed(2)}`] : [];
    }),
  );
}

test("every text level reads at AA on every surface of every theme, light and dark", () => {
  for (const id of themeIds)
    for (const scheme of schemes) {
      const tokens = themeDeclarations(id, scheme);
      expect([
        id,
        scheme,
        [...below(tokens, text, surfaces, 4.5), ...below(tokens, statusWords, surfaces, 4.5)],
      ]).toEqual([id, scheme, []]);
    }
});

test("status marks, the accent and its label stand out in every theme", () => {
  const fills = ["--background", "--sidebar", "--surface-1", "--surface-2", "--active"];
  for (const id of themeIds)
    for (const scheme of schemes) {
      const tokens = themeDeclarations(id, scheme);
      expect([
        id,
        scheme,
        [
          ...below(tokens, [...statusMarks, "--ring"], fills, 3),
          ...below(
            tokens,
            ["--ring-foreground"],
            ["--ring", "--ring-hover", "--ring-pressed"],
            4.5,
          ),
        ],
      ]).toEqual([id, scheme, []]);
    }
});

test("a danger button's label reads at AA on its fill at rest, hovered and pressed, in every theme", () => {
  for (const id of themeIds)
    for (const scheme of schemes) {
      const tokens = themeDeclarations(id, scheme);
      expect([
        id,
        scheme,
        below(
          tokens,
          ["--danger-foreground"],
          ["--danger", "--danger-hover", "--danger-pressed"],
          4.5,
        ),
      ]).toEqual([id, scheme, []]);
    }
});

test("the Stop button's icon reads at 3:1 on its fill at rest, hovered and pressed, in every theme", () => {
  for (const id of themeIds)
    for (const scheme of schemes) {
      const tokens = themeDeclarations(id, scheme);
      expect([
        id,
        scheme,
        below(tokens, ["--stop-foreground"], ["--stop", "--stop-hover", "--stop-pressed"], 3),
      ]).toEqual([id, scheme, []]);
    }
});

test("code and diff text read at AA on the code background and on added and removed lines", () => {
  const syntax = ["--syn-kw", "--syn-fn", "--syn-str", "--syn-num", "--syn-type", "--syn-com"];
  for (const id of themeIds)
    for (const scheme of schemes) {
      const tokens = themeDeclarations(id, scheme);
      expect([
        id,
        scheme,
        [
          ...below(
            tokens,
            ["--foreground", ...syntax],
            ["--code", "--diff-add", "--diff-del"],
            4.5,
          ),
          ...below(tokens, ["--diff-add-text"], ["--diff-add"], 4.5),
          ...below(tokens, ["--diff-del-text"], ["--diff-del"], 4.5),
        ],
      ]).toEqual([id, scheme, []]);
    }
});

/** How far a colour sits from pure white (dark schemes) or pure black (light ones). */
const fromExtreme = (colour: string | undefined, scheme: Scheme) =>
  ratio(colour, scheme === "dark" ? "#FFFFFF" : "#000000");

test("text is a softened ink, never glaring pure white in dark or pure black in light", () => {
  for (const id of themeIds)
    for (const scheme of schemes) {
      const tokens = themeDeclarations(id, scheme);
      const glaring = [
        // Body text sits clearly off the extreme; text on glass is a step stronger but still off it.
        ...(fromExtreme(tokens["--foreground"], scheme) < 1.25 ? ["--foreground"] : []),
        ...(fromExtreme(tokens["--glass-foreground"], scheme) < 1.12 ? ["--glass-foreground"] : []),
      ];
      expect([id, scheme, glaring]).toEqual([id, scheme, []]);
    }
});

test("ace's ink-filled primary button uses the same softened ink as its text", () => {
  for (const scheme of schemes) {
    const tokens = themeDeclarations("ace", scheme);
    expect(tokens["--ring"]).toBe(tokens["--foreground"]);
    expect(fromExtreme(tokens["--ring-hover"], scheme)).toBeGreaterThan(1.1);
  }
});

test("text, secondary, quiet and faint text stay one step apart on the page in every theme", () => {
  const tiers = ["--foreground", "--muted-foreground", "--subtle-foreground", "--faint-foreground"];
  for (const id of themeIds)
    for (const scheme of schemes) {
      const tokens = themeDeclarations(id, scheme);
      const readings = tiers.map((tier) => ratio(tokens[tier], tokens["--background"]));
      const outOfOrder = tiers
        .slice(1)
        .filter((_, index) => readings[index + 1]! >= readings[index]!);
      expect([id, scheme, outOfOrder]).toEqual([id, scheme, []]);
    }
});

const accentChoices: AccentChoice[] = [
  ...accentIds.map((accent) => ({ accent, customAccent: "#3E8E7E" })),
  ...["#FFFFFF", "#000000", "#FFFF00", "#2A55B0", "#2F906E", "#0E7A6C", "#C93838"].map(
    (customAccent) => ({ accent: "custom" as const, customAccent }),
  ),
];

test("working, needs-you, done and failed never look like the accent, whatever accent is picked", () => {
  for (const id of themeIds)
    for (const scheme of schemes)
      for (const choice of accentChoices) {
        const tokens = themeDeclarations(id, scheme, choice);
        const accent = rgb(tokens["--ring"]);
        const near = statusMarks.filter(
          (mark) => deltaE(accent, rgb(tokens[mark])) < statusDistance,
        );
        expect([id, scheme, choice, near]).toEqual([id, scheme, choice, []]);
      }
});
