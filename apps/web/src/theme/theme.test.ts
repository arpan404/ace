import { expect, test } from "vitest";
import { formatKeys } from "@/lib/keymap.ts";
import { projectTintCount } from "@ace/ui-core";
import { accentColours } from "./accent.ts";
import { worstContrast } from "./colour.ts";
import { contrastRatio, contrastWarnings, parseOpaqueColor } from "./contrast.ts";
import { themeRule } from "./css.ts";
import { parseThemeFile, themeFromFile, withToken } from "./custom-themes.ts";
import { accentNames, basePreset, presetThemes } from "./presets.ts";
import { themeSurfaces } from "./surfaces.ts";

test("every preset clears the WCAG checks the theme editor runs", () => {
  for (const theme of presetThemes)
    expect([theme.id, contrastWarnings(theme.tokens)]).toEqual([theme.id, []]);
});

const rgb = (value: string) => {
  const parsed = parseOpaqueColor(value);
  if (!parsed) throw new Error(`not an opaque colour: ${value}`);
  return parsed;
};
/** Every colour of a 16-step cube, plus the mid greys where black and white labels tie. */
const customAccents = [
  ...Array.from({ length: 4096 }, (_, i) =>
    [i >> 8, (i >> 4) & 15, i & 15].map((c) => (c * 17).toString(16).padStart(2, "0")),
  ).map((c) => `#${c.join("")}`),
  "#777777",
  "#757575",
  "#767676",
  "#111111",
];

test("a label on an accent fill reads at AA for every preset, accent and custom colour", () => {
  for (const theme of presetThemes) {
    for (const accent of ["theme", ...accentNames] as const) {
      const { ring, foreground } = accentColours(theme, { accent, customAccent: "#000000" });
      expect(
        contrastRatio(rgb(ring), rgb(foreground)),
        `${theme.id} ${accent}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
  for (const customAccent of customAccents) {
    const { ring, foreground } = accentColours(basePreset("dark"), {
      accent: "custom",
      customAccent,
    });
    expect(contrastRatio(rgb(ring), rgb(foreground)), customAccent).toBeGreaterThanOrEqual(4.5);
  }
});

test("links read at AA on every surface whatever accent is chosen, white on Light included", () => {
  for (const theme of presetThemes) {
    const surfaces = themeSurfaces(theme.tokens).map((surface) => surface.rgb);
    for (const customAccent of customAccents.filter((_, i) => i % 7 === 0).concat("#FFFFFF")) {
      const { text } = accentColours(theme, { accent: "custom", customAccent });
      expect(
        worstContrast(rgb(text), surfaces),
        `${theme.id} ${customAccent}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
  // The person's own colour is kept where it already reads.
  expect(
    accentColours(basePreset("dark"), { accent: "custom", customAccent: "#7AA2F7" }).text,
  ).toBe("#7AA2F7");
});

/** A declaration's value in a theme's generated rule, as the page receives it. */
const declared = (css: string, name: string) => new RegExp(`${name}:([^;}]+)`).exec(css)?.[1];
const statusHues = ["needs-you", "working", "waiting", "unresponsive", "failed", "done"] as const;

test("status words read at AA on every surface of every preset, a selected row over clear glass included", () => {
  for (const theme of presetThemes) {
    const css = themeRule(theme);
    const surfaces = themeSurfaces(theme.tokens).map((surface) => surface.rgb);
    for (const hue of statusHues) {
      const text = declared(css, `--status-${hue}-text`);
      expect(text, `${theme.id} ${hue}`).toBeDefined();
      expect(worstContrast(rgb(text ?? ""), surfaces), `${theme.id} ${hue}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  }
});

test("a custom theme's pale status hue is deepened until its words read, and a readable one is kept", () => {
  const pale = withToken(basePreset("light"), "--status-needs-you", "#FFE8C2");
  const surfaces = themeSurfaces(pale.tokens).map((surface) => surface.rgb);
  const text = declared(themeRule(pale), "--status-needs-you-text") ?? "";
  expect(worstContrast(rgb(text), surfaces)).toBeGreaterThanOrEqual(4.5);
  // Dark's working blue already reads everywhere: the words keep the person's exact hue.
  const dark = basePreset("dark");
  expect(declared(themeRule(dark), "--status-working-text")).toBe(dark.tokens["--status-working"]);
});

test("grey text that reads on the page but not on a solid popover or a selected row is flagged", () => {
  // The old Dark subtle grey: 4.9:1 on the page, about 4:1 on a menu with glass turned off.
  const theme = withToken(basePreset("dark"), "--subtle-foreground", "#808080");
  expect(contrastWarnings(theme.tokens)).toEqual([
    expect.objectContaining({ token: "--subtle-foreground", label: "Subtle text" }),
  ]);
});

test("a project badge's letters read at AA on its wash over every surface of every preset", () => {
  for (const theme of presetThemes)
    for (const surface of themeSurfaces(theme.tokens))
      for (let tint = 1; tint <= projectTintCount; tint++) {
        const letters = rgb(theme.tokens[`--project-${tint}` as keyof typeof theme.tokens]);
        // The badge's wash: the tint at 16% over the surface.
        const wash = surface.rgb.map((c, i) => Math.round(letters[i]! * 0.16 + c * 0.84)) as [
          number,
          number,
          number,
        ];
        expect(
          contrastRatio(letters, wash),
          `${theme.id} ${surface.name} ${tint}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
});

test("a custom theme with grey-on-grey secondary text is flagged", () => {
  const theme = withToken(basePreset("dark"), "--muted-foreground", "#2A2A2A");
  expect(contrastWarnings(theme.tokens)).toEqual([
    expect.objectContaining({ token: "--muted-foreground", label: "Secondary text", minimum: 4.5 }),
  ]);
});

test("an imported theme keeps its known tokens, drops unknown ones and fills the rest from its scheme", () => {
  const file = parseThemeFile(
    JSON.stringify({
      name: "Ink",
      scheme: "light",
      tokens: { "--background": "#FAFAF7", "--made-up": "red" },
    }),
  );
  const theme = themeFromFile(file, "custom-ink");
  expect(theme.tokens["--background"]).toBe("#FAFAF7");
  expect(theme.tokens["--foreground"]).toBe(basePreset("light").tokens["--foreground"]);
  expect(Object.keys(theme.tokens)).not.toContain("--made-up");
  expect(themeRule(theme)).not.toContain("--made-up");
});

test("files that are not themes are rejected with a readable reason", () => {
  expect(() => parseThemeFile("not json")).toThrow(
    "That file couldn't be read. Choose an exported ace theme file.",
  );
  expect(() => parseThemeFile(JSON.stringify({ name: "x", tokens: {} }))).toThrow(
    /Choose a file exported from the theme editor/,
  );
});

test("a token value cannot escape its theme rule", () => {
  const theme = withToken(basePreset("dark"), "--background", "red}body{display:none");
  const css = themeRule(theme);
  expect(css.match(/\{/g)).toHaveLength(1);
  expect(css.match(/\}/g)).toHaveLength(1);
});

test("shortcuts read as platform glyphs", () => {
  expect(formatKeys("shift+mod+n", true)).toBe("⇧⌘N");
  expect(formatKeys("shift+mod+n", false)).toBe("Shift+Ctrl+N");
  expect(formatKeys("ctrl+`", true)).toBe("⌃`");
  expect(formatKeys("g h", true)).toBe("G H");
});
