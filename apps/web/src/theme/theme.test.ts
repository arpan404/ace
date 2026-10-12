import { expect, test } from "vitest";
import { formatKeys } from "@/lib/keymap.ts";
import { memoryKeyValue } from "@/test/harness.tsx";
import { defaultAppearance, loadAppearance, resolveAppearance } from "./appearance.ts";
import { worstContrast } from "./colour.ts";
import { contrastWarnings, parseOpaqueColor } from "./contrast.ts";
import { themeDeclarations, themeRule } from "./css.ts";
import { glassEngine } from "./glass.ts";
import { themeIds, themes } from "./palettes.ts";
import { paletteSurfaces } from "./surfaces.ts";

const schemes = ["light", "dark"] as const;
const rgb = (value: string | undefined) => {
  const parsed = parseOpaqueColor(value);
  if (!parsed) throw new Error(`not an opaque colour: ${value}`);
  return parsed;
};

test("every theme passes WCAG AA in light and dark, highlighted rows and glass included", () => {
  for (const id of themeIds)
    for (const scheme of schemes)
      expect([id, scheme, contrastWarnings(themes[id][scheme], scheme)]).toEqual([id, scheme, []]);
});

test("quiet text that reads on the page but not on a highlighted menu row is flagged", () => {
  // The prototype's Ace dark grey: 5.4:1 on the page, about 3.8:1 on a highlighted solid menu row.
  const palette = { ...themes.ace.dark, t3: "#8B8F98" };
  expect(contrastWarnings(palette, "dark")).toEqual([
    expect.objectContaining({ label: "Quiet text", minimum: 4.5 }),
  ]);
});

test("a label that can't be read on the accent fill is flagged", () => {
  const palette = { ...themes.paper.light, accentFg: "#2A2825" };
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
  const rule = themeRule("tide", "dark");
  expect(rule.startsWith('[data-theme="tide"][data-scheme="dark"]{')).toBe(true);
  expect(rule).toContain(`--background:${themes.tide.dark.s0}`);
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

test("translucent surfaces fall back to solid while the OS reduces transparency", () => {
  expect(resolveAppearance(defaultAppearance, os).surface).toBe("translucent");
  expect(resolveAppearance(defaultAppearance, { ...os, reducedTransparency: true }).surface).toBe(
    "solid",
  );
  expect(resolveAppearance({ ...defaultAppearance, surface: "solid" }, os).surface).toBe("solid");
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

test("a saved appearance keeps each valid choice and replaces only the unreadable ones", () => {
  const storage = memoryKeyValue();
  storage.setItem(
    "ace.appearance",
    JSON.stringify({ mode: "dark", theme: "midnight", surface: "solid", reduceMotion: 1 }),
  );
  expect(loadAppearance(storage)).toEqual({
    ...defaultAppearance,
    mode: "dark",
    theme: "ace",
    surface: "solid",
  });
});

const userAgents = {
  chrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  electron:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ace/1.0.0 Chrome/140.0.7339.41 Electron/38.0.0 Safari/537.36",
  safari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.6; rv:143.0) Gecko/20100101 Firefox/143.0",
  chromeOnIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1",
};

test("liquid glass is used only where SVG backdrop filters render", () => {
  expect(glassEngine(userAgents.chrome)).toBe("liquid");
  expect(glassEngine(userAgents.electron)).toBe("liquid");
  expect(glassEngine(userAgents.safari)).toBe("blur");
  expect(glassEngine(userAgents.firefox)).toBe("blur");
  // Chrome on iOS is WebKit underneath.
  expect(glassEngine(userAgents.chromeOnIphone)).toBe("blur");
  // A Chromium browser that reduces its user agent still reports its brand.
  expect(glassEngine("Mozilla/5.0", [{ brand: "Chromium" }])).toBe("liquid");
});

test("shortcuts read as platform glyphs", () => {
  expect(formatKeys("shift+mod+n", true)).toBe("⇧⌘N");
  expect(formatKeys("shift+mod+n", false)).toBe("Shift+Ctrl+N");
  expect(formatKeys("ctrl+`", true)).toBe("⌃`");
  expect(formatKeys("g h", true)).toBe("G H");
});
