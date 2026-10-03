import { expect, test } from "vitest";
import { formatKeys } from "@/lib/keymap.ts";
import { contrastWarnings } from "./contrast.ts";
import { themeRule } from "./css.ts";
import { parseThemeFile, themeFromFile, withToken } from "./custom-themes.ts";
import { basePreset, presetThemes } from "./presets.ts";

test("every preset clears the WCAG checks the theme editor runs", () => {
  for (const theme of presetThemes)
    expect([theme.id, contrastWarnings(theme.tokens)]).toEqual([theme.id, []]);
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
  expect(() => parseThemeFile("not json")).toThrow("That file isn't JSON.");
  expect(() => parseThemeFile(JSON.stringify({ name: "x", tokens: {} }))).toThrow(
    /needs a tokens object with --background/,
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
