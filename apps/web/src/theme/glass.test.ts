import { expect, test } from "vitest";
import { contrastRatio, parseOpaqueColor, type Rgb } from "./colour.ts";
import { themeDeclarations } from "./css.ts";
import { edgeMap, fitStep, glassEngine, glassGeometry, mapSize } from "./glass.ts";
import { themeIds, themes } from "./palettes.ts";
import { over } from "./surfaces.ts";

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

test("glass bends only a thin rim, the same for a palette and a menu", () => {
  const palette = glassGeometry(620, 540, 14);
  const menu = glassGeometry(240, 180, 14);
  expect(palette.band).toBeLessThanOrEqual(10);
  expect(palette.scale).toBeLessThan(palette.band);
  expect([menu.band, menu.scale]).toEqual([palette.band, palette.scale]);
  // A pill too small for the full rim gets a shallower one rather than a bend through its label.
  const pill = glassGeometry(120, 32, 16);
  expect(pill.band).toBeLessThan(palette.band);
  expect(pill.scale).toBeLessThanOrEqual(pill.band);
});

test("a layer gets its rim at once when it opens, and a new one only after a resize settles", () => {
  const opened = glassGeometry(320, 240, 14);
  // First measure: the rim is there from the first frame.
  expect(fitStep(undefined, opened)).toBe("now");
  // Measured again at the same size, or a pixel off: nothing to do.
  expect(fitStep(opened, opened)).toBe("keep");
  expect(fitStep(opened, glassGeometry(321, 239, 14))).toBe("keep");
  // Resized: the old rim comes off now and a new filter waits for the size to settle.
  const taller = glassGeometry(320, 300, 14);
  expect(fitStep(opened, taller)).toBe("settle");
  // Still settling, with no rim on: each further size waits too.
  expect(fitStep(null, taller)).toBe("settle");
  // Moved to a screen of another density: its map is redrawn for it.
  expect(fitStep(opened, glassGeometry(320, 240, 14, 2))).toBe("settle");
});

/** Red and green of the map pixel at CSS position (x, y). */
function sampler(geometry: ReturnType<typeof glassGeometry>) {
  const map = edgeMap(geometry);
  const { width } = mapSize(geometry);
  return (x: number, y: number) => {
    const i = (Math.floor(y * geometry.density) * width + Math.floor(x * geometry.density)) * 4;
    return [map[i], map[i + 1]];
  };
}

test("the displacement map bends only inside the rim and leaves everything behind text still", () => {
  const geometry = glassGeometry(200, 120, 14);
  const at = sampler(geometry);
  // Anywhere past the rim is exactly no displacement, so text behind a layer is never warped.
  for (const [x, y] of [
    [100, 60],
    [geometry.band + 1, 60],
    [100, geometry.band + 1],
    [200 - geometry.band - 2, 60],
  ] as const)
    expect(at(x, y)).toEqual([128, 128]);
  // The left edge pulls from inside (rightwards), the top edge from below, the right from the left.
  expect(at(0, 60)[0]).toBeGreaterThan(200);
  expect(at(100, 0)[1]).toBeGreaterThan(200);
  expect(at(199, 60)[0]).toBeLessThan(56);
});

test("on a HiDPI screen the map is drawn at device pixels and its rim is a smooth ramp", () => {
  const crisp = glassGeometry(200, 120, 14, 2);
  expect(mapSize(crisp)).toEqual({ width: 400, height: 240 });
  const map = edgeMap(crisp);
  const row = 120 * 400 * 4;
  const reds = Array.from({ length: crisp.band * 2 + 2 }, (_, x) => map[row + x * 4] ?? 128);
  // Falls from the edge to the flat middle without a step large enough to show as a band.
  for (let x = 1; x < reds.length; x++) {
    expect(reds[x]).toBeLessThanOrEqual(reds[x - 1]!);
    expect(reds[x - 1]! - reds[x]!).toBeLessThanOrEqual(16);
  }
  expect(reds.at(-1)).toBe(128);
});

/** The colour and opacity of a declared `color-mix(in srgb, #rrggbb N%, transparent)` tint. */
function tint(value: string | undefined): { rgb: Rgb; alpha: number } {
  const match = /color-mix\(in srgb, (#[0-9a-f]{6}) (\d+)%, transparent\)/i.exec(value ?? "");
  const rgb = parseOpaqueColor(match?.[1]);
  if (!match || !rgb) throw new Error(`not a glass tint: ${value}`);
  return { rgb, alpha: Number(match[2]) / 100 };
}

const backdrops: Record<string, Rgb> = {
  "white backdrop": [255, 255, 255],
  "black backdrop": [0, 0, 0],
};
/** Text and secondary text at AA over anything; quiet hints at 3:1. */
const levels = { "--foreground": 4.5, "--muted-foreground": 4.5, "--subtle-foreground": 3 };

test("text on glass reads at AA over a white and a black backdrop in every theme, light and dark", () => {
  const failures: string[] = [];
  for (const id of themeIds)
    for (const scheme of ["light", "dark"] as const) {
      const tokens = themeDeclarations(id, scheme);
      const glass = tint(tokens["--glass-tint"]);
      for (const [backdrop, behind] of Object.entries(backdrops)) {
        const surface = over(glass.rgb, glass.alpha, behind);
        for (const [token, minimum] of Object.entries(levels)) {
          const colour = parseOpaqueColor(tokens[token]);
          const ratio = colour ? contrastRatio(colour, surface) : 0;
          if (ratio < minimum)
            failures.push(
              `${id} ${scheme}: ${token} on glass over a ${backdrop} ${ratio.toFixed(2)}`,
            );
        }
      }
    }
  expect(failures).toEqual([]);
});

test("glass stays visibly glass where a theme has it, and Signal has none", () => {
  for (const id of themeIds)
    for (const scheme of ["light", "dark"] as const) {
      const { alpha } = tint(themeDeclarations(id, scheme)["--glass-tint"]);
      if (themes[id][scheme].material.glass) expect(alpha, `${id} ${scheme}`).toBeLessThan(0.95);
      else expect(alpha, `${id} ${scheme}`).toBe(1);
    }
});
