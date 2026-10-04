import { expect, test } from "vitest";
import { contrastRatio, parseOpaqueColor } from "@/theme/contrast.ts";
import { presetThemes, type Theme } from "@/theme/presets.ts";
import type { TokenName } from "@/theme/tokens.ts";
import { ansiNames, minimumTextContrast, terminalPalette, type Rgb } from "./palette.ts";

const rgb = (theme: Theme, token: TokenName): Rgb => {
  const parsed = parseOpaqueColor(theme.tokens[token]);
  if (!parsed) throw new Error(`${theme.id} ${token} is not opaque`);
  return parsed;
};
const parse = (value: string): Rgb => {
  const parsed = parseOpaqueColor(value);
  if (!parsed) throw new Error(`not a colour: ${value}`);
  return parsed;
};
const paletteOf = (theme: Theme) =>
  terminalPalette({
    background: rgb(theme, "--background"),
    foreground: rgb(theme, "--foreground"),
    muted: rgb(theme, "--muted-foreground"),
    subtle: rgb(theme, "--subtle-foreground"),
    red: rgb(theme, "--status-failed"),
    green: rgb(theme, "--status-done"),
    yellow: rgb(theme, "--status-needs-you"),
    blue: rgb(theme, "--status-working"),
    magenta: rgb(theme, "--status-waiting"),
    cyan: rgb(theme, "--accent-teal"),
    ring: rgb(theme, "--accent-blue"),
  });

const textColours = ansiNames.filter(
  (name) => !["black", "white", "brightWhite"].includes(name),
) as readonly (typeof ansiNames)[number][];

test.each(presetThemes.map((theme) => [theme.name, theme] as const))(
  "every colour a program prints as text reads on the %s terminal",
  (_name, theme) => {
    const palette = paletteOf(theme);
    const background = parse(palette.background);
    for (const name of [...textColours, "foreground" as const])
      expect(
        contrastRatio(parse(palette[name]), background),
        `${theme.id} ${name}`,
      ).toBeGreaterThanOrEqual(minimumTextContrast);
  },
);

test.each(presetThemes.map((theme) => [theme.name, theme] as const))(
  "the %s terminal's red, green and yellow are the theme's failed, done and needs-you colours",
  (_name, theme) => {
    const palette = paletteOf(theme);
    const background = rgb(theme, "--background");
    // Unchanged wherever the theme's own colour already reads.
    for (const [name, token] of [
      ["red", "--status-failed"],
      ["green", "--status-done"],
      ["yellow", "--status-needs-you"],
    ] as const)
      if (contrastRatio(rgb(theme, token), background) >= minimumTextContrast)
        expect(parse(palette[name])).toEqual(rgb(theme, token));
  },
);

test("bright colours differ from their normal pair, so bold output still stands out", () => {
  for (const theme of presetThemes) {
    const palette = paletteOf(theme);
    for (const [hue, bright] of [
      ["red", "brightRed"],
      ["green", "brightGreen"],
      ["yellow", "brightYellow"],
      ["blue", "brightBlue"],
      ["magenta", "brightMagenta"],
      ["cyan", "brightCyan"],
    ] as const)
      expect(palette[bright], `${theme.id} ${hue}`).not.toBe(palette[hue]);
  }
});
