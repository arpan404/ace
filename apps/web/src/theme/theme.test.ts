import { expect, test } from "vitest";
import { formatKeys } from "@/lib/keymap.ts";
import { memoryKeyValue } from "@/test/harness.tsx";
import { defaultAppearance, loadAppearance, resolveAppearance } from "./appearance.ts";
import { worstContrast } from "./colour.ts";
import { contrastWarnings, parseOpaqueColor } from "./contrast.ts";
import { themeDeclarations, themeRule } from "./css.ts";
import { accentIds, themedPalette, type AccentChoice } from "./accent.ts";
import { nearStatus, statusDistance, statusGap } from "./accent-fit.ts";
import { deltaE, rgbToOklch } from "./colour.ts";
import { sharedStatus, themeIds, themes } from "./palettes.ts";
import { paletteSurfaces } from "./surfaces.ts";

const schemes = ["light", "dark"] as const;
const rgb = (value: string | undefined) => {
  const parsed = parseOpaqueColor(value);
  if (!parsed) throw new Error(`not an opaque colour: ${value}`);
  return parsed;
};
const chroma = (value: string) => rgbToOklch(rgb(value)).c;

/** Every accent choice, plus custom colours at the extremes and two on top of a status. */
const accentChoices: AccentChoice[] = [
  ...accentIds.map((accent) => ({ accent, customAccent: "#3E8E7E" })),
  ...["#FFFFFF", "#000000", "#FFFF00", "#2A55B0", "#A3233A"].map((customAccent) => ({
    accent: "custom" as const,
    customAccent,
  })),
];

test("every theme passes WCAG AA in light and dark with every accent, rows and glass included", () => {
  for (const id of themeIds)
    for (const scheme of schemes)
      for (const choice of accentChoices) {
        const palette = themedPalette(id, scheme, choice);
        expect([id, scheme, choice, contrastWarnings(palette, scheme)]).toEqual([
          id,
          scheme,
          choice,
          [],
        ]);
      }
});

test("no picked accent passes for any status colour: one too close is moved clear of it", () => {
  for (const id of themeIds)
    for (const scheme of schemes)
      for (const choice of accentChoices) {
        if (choice.accent === "theme") continue;
        const palette = themedPalette(id, scheme, choice);
        if (chroma(palette.accent) > 0.03)
          expect(
            statusGap(palette.accent, palette, scheme),
            `${id} ${scheme} ${JSON.stringify(choice)}`,
          ).toBeGreaterThanOrEqual(statusDistance);
      }
  // The working blue itself, picked as a custom accent, is flagged and moved.
  const working = themes.ace.light.working;
  expect(nearStatus(working, "light", themes.ace.light)).toBe(true);
  const moved = themedPalette("ace", "light", { accent: "custom", customAccent: working });
  expect(deltaE(rgb(moved.accent), rgb(working))).toBeGreaterThanOrEqual(statusDistance);
});

test("no two themes share an accent, in either scheme", () => {
  // Themes are colour only: their accents are what tells them apart at a glance.
  for (const scheme of schemes)
    for (const a of themeIds)
      for (const b of themeIds) {
        if (a >= b) continue;
        const apart = deltaE(rgb(themes[a][scheme].accent), rgb(themes[b][scheme].accent));
        expect(apart, `${a} vs ${b} (${scheme})`).toBeGreaterThan(8);
      }
});

/** A theme's interface, transcript and code font stacks, as the page receives them. */
const fonts = (id: (typeof themeIds)[number]) => {
  const tokens = themeDeclarations(id, "light");
  return [tokens["--font-sans"], tokens["--font-prose"], tokens["--font-mono"]];
};

test("every theme keeps the same fonts", () => {
  for (const id of themeIds) expect([id, fonts(id)]).toEqual([id, fonts("ace")]);
});

/** Every status colour a theme sets in one scheme: marks and words. */
const statusOf = (id: (typeof themeIds)[number], scheme: "light" | "dark", choice?: AccentChoice) =>
  Object.fromEntries(
    Object.entries(themeDeclarations(id, scheme, choice)).filter(([name]) =>
      name.startsWith("--status-"),
    ),
  );

test("picking an accent never changes a status colour, and waiting is shared by every theme", () => {
  for (const scheme of schemes)
    for (const id of themeIds) {
      const reference = statusOf(id, scheme);
      for (const choice of accentChoices)
        expect([id, choice, statusOf(id, scheme, choice)]).toEqual([id, choice, reference]);
      expect(reference["--status-waiting"]).toBe(sharedStatus[scheme].waiting);
    }
});

test("quiet text that reads on the page but not on a highlighted menu row is flagged", () => {
  // 5.2:1 on ace's dark page, but under 4.5:1 on a highlighted row of a solid menu.
  const palette = { ...themes.ace.dark, t3: "#888888" };
  expect(contrastWarnings(palette, "dark")).toEqual([
    expect.objectContaining({ label: "Quiet text", minimum: 4.5 }),
  ]);
});

test("a label that can't be read on the accent fill is flagged", () => {
  const palette = { ...themes.ace.light, accentFg: "#2A2825" };
  expect(contrastWarnings(palette, "light").map((warning) => warning.label)).toContain(
    "Label on accent",
  );
});

test("waiting and not-responding words read at AA on every surface of every theme", () => {
  for (const id of themeIds)
    for (const scheme of schemes) {
      const surfaces = paletteSurfaces(themes[id][scheme], scheme).map((surface) => surface.rgb);
      const declarations = themeDeclarations(id, scheme);
      for (const name of ["--status-waiting-text", "--status-unresponsive-text"])
        expect(
          worstContrast(rgb(declarations[name]), surfaces),
          `${id} ${scheme} ${name}`,
        ).toBeGreaterThanOrEqual(4.5);
    }
});

test("a theme rule themes any element carrying both attributes, so swatches preview real tokens", () => {
  const rule = themeRule("midnight", "dark");
  expect(rule.startsWith('[data-theme="midnight"][data-scheme="dark"]{')).toBe(true);
  expect(rule).toContain(`--background:${themes.midnight.dark.s0}`);
  expect(rule).toContain("color-scheme:dark");
});

const os = { dark: false, reducedMotion: false, reducedTransparency: false };

test("System mode follows the OS's light or dark; Light and Dark ignore it", () => {
  expect(resolveAppearance(defaultAppearance, { ...os, dark: true }).scheme).toBe("dark");
  expect(resolveAppearance(defaultAppearance, os).scheme).toBe("light");
  expect(resolveAppearance({ ...defaultAppearance, mode: "light" }, { ...os, dark: true })).toEqual(
    expect.objectContaining({ scheme: "light" }),
  );
});

test("glass falls back to solid at translucency 0 and while the OS reduces transparency", () => {
  expect(resolveAppearance(defaultAppearance, os)).toMatchObject({
    surface: "translucent",
    translucency: 100,
  });
  expect(resolveAppearance(defaultAppearance, { ...os, reducedTransparency: true })).toMatchObject({
    surface: "solid",
    translucency: 0,
  });
  expect(resolveAppearance({ ...defaultAppearance, translucency: 0 }, os).surface).toBe("solid");
  expect(resolveAppearance({ ...defaultAppearance, translucency: 40 }, os)).toMatchObject({
    surface: "translucent",
    translucency: 40,
  });
});

/** The translucency loaded from a stored appearance of `value`. */
function stored(value: object) {
  const storage = memoryKeyValue();
  storage.setItem("ace.appearance", JSON.stringify(value));
  return loadAppearance(storage).translucency;
}

test("a stored Surfaces choice carries over to the slider: Solid is 0, Translucent the default", () => {
  expect(stored({ theme: "midnight", surface: "solid" })).toBe(0);
  expect(stored({ theme: "midnight", surface: "translucent" })).toBe(
    defaultAppearance.translucency,
  );
  expect(stored({ theme: "midnight" })).toBe(defaultAppearance.translucency);
  // Once the slider has been set, its value wins over a leftover Surfaces field.
  expect(stored({ surface: "solid", translucency: 60 })).toBe(60);
  expect(stored({ translucency: 250 })).toBe(defaultAppearance.translucency);
});

test("Reduce motion follows the OS under System, and On or Off overrides it", () => {
  const reduced = { ...os, reducedMotion: true };
  expect(resolveAppearance(defaultAppearance, reduced).reduceMotion).toBe(true);
  expect(resolveAppearance(defaultAppearance, os).reduceMotion).toBe(false);
  expect(
    resolveAppearance({ ...defaultAppearance, reduceMotion: "off" }, reduced).reduceMotion,
  ).toBe(false);
  expect(resolveAppearance({ ...defaultAppearance, reduceMotion: "on" }, os).reduceMotion).toBe(
    true,
  );
});

test("a saved appearance keeps each valid choice, and a removed theme falls back to ace", () => {
  const storage = memoryKeyValue();
  storage.setItem(
    "ace.appearance",
    JSON.stringify({
      mode: "dark",
      theme: "graphite",
      accent: "violet",
      customAccent: "not a colour",
      translucency: 30,
      reduceMotion: 1,
    }),
  );
  expect(loadAppearance(storage)).toEqual({
    ...defaultAppearance,
    theme: "ace",
    mode: "dark",
    accent: "violet",
    translucency: 30,
  });
});

test("shortcuts read as platform glyphs", () => {
  expect(formatKeys("shift+mod+n", true)).toBe("⇧⌘N");
  expect(formatKeys("shift+mod+n", false)).toBe("Shift+Ctrl+N");
  expect(formatKeys("ctrl+`", true)).toBe("⌃`");
  expect(formatKeys("g h", true)).toBe("G H");
});
