import { expect, test } from "vitest";
import { formatKeys } from "@/lib/keymap.ts";
import { memoryKeyValue } from "@/test/harness.tsx";
import { defaultAppearance, loadAppearance, resolveAppearance } from "./appearance.ts";
import { worstContrast } from "./colour.ts";
import { contrastWarnings, parseOpaqueColor } from "./contrast.ts";
import { themeDeclarations, themeRule } from "./css.ts";
import { edgeMap, fitStep, glassEngine, glassGeometry } from "./glass.ts";
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

/** Every status declaration a theme sets in one scheme. */
const statusOf = (id: (typeof themeIds)[number], scheme: "light" | "dark") =>
  Object.fromEntries(
    Object.entries(themeDeclarations(id, scheme)).filter(([name]) => name.startsWith("--status-")),
  );

test("a status looks the same in every theme; only the accent changes", () => {
  for (const scheme of schemes) {
    const reference = statusOf("graphite", scheme);
    for (const id of themeIds) expect([id, statusOf(id, scheme)]).toEqual([id, reference]);
  }
});

test("quiet text that reads on the page but not on a highlighted menu row is flagged", () => {
  // 5.1:1 on Graphite's dark page, but under 4.5:1 on a highlighted row of a solid menu.
  const palette = { ...themes.graphite.dark, t3: "#888888" };
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

test("liquid glass bends a fixed rim in pixels, whatever the layer's size", () => {
  const palette = glassGeometry(620, 540, 14);
  const menu = glassGeometry(240, 180, 14);
  expect([palette.band, palette.scale]).toEqual([24, 24]);
  expect([menu.band, menu.scale]).toEqual([24, 24]);
  // A tooltip too small for the full rim gets a shallower one rather than a bend through its text.
  const tooltip = glassGeometry(90, 24, 10);
  expect(tooltip.band).toBeLessThan(24);
  expect(tooltip.scale).toBeLessThanOrEqual(tooltip.band);
  // Layers a pixel apart share one filter.
  expect(glassGeometry(241, 181, 14).key).toBe(menu.key);
});

test("a layer gets its rim at once when it opens, and a new one only after a resize settles", () => {
  const opened = glassGeometry(320, 240, 14);
  // First measure: the rim is there from the first frame.
  expect(fitStep(undefined, opened)).toBe("now");
  // Measured again at the same size: nothing to do.
  expect(fitStep(opened.key, opened)).toBe("keep");
  // Resized: the old rim comes off now and a new filter waits for the size to settle.
  const taller = glassGeometry(320, 300, 14);
  expect(fitStep(opened.key, taller)).toBe("settle");
  // Still settling, with no rim on: each further size waits too, back to the old one included.
  expect(fitStep("", taller)).toBe("settle");
  expect(fitStep("", opened)).toBe("settle");
  // A pixel of jitter is the same filter.
  expect(fitStep(opened.key, glassGeometry(321, 241, 14))).toBe("keep");
});

test("the displacement map moves only the rim and leaves the middle still", () => {
  const geometry = glassGeometry(200, 120, 14);
  const map = edgeMap(geometry);
  const at = (x: number, y: number) => {
    const i = (y * geometry.width + x) * 4;
    return [map[i], map[i + 1]];
  };
  expect(at(100, 60)).toEqual([128, 128]);
  expect(at(100, 60 - 30)).toEqual([128, 128]);
  // The left edge pulls from inside (rightwards), the top edge from below.
  expect(at(0, 60)[0]).toBeGreaterThan(200);
  expect(at(100, 0)[1]).toBeGreaterThan(200);
  expect(at(geometry.width - 1, 60)[0]).toBeLessThan(56);
});

test("shortcuts read as platform glyphs", () => {
  expect(formatKeys("shift+mod+n", true)).toBe("⇧⌘N");
  expect(formatKeys("shift+mod+n", false)).toBe("Shift+Ctrl+N");
  expect(formatKeys("ctrl+`", true)).toBe("⌃`");
  expect(formatKeys("g h", true)).toBe("G H");
});
