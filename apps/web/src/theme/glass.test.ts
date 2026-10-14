import { expect, test } from "vitest";
import { contrastRatio, parseOpaqueColor, type Rgb } from "./colour.ts";
import { themeDeclarations } from "./css.ts";
import { edgeMap, fitStep, glassEngine, glassGeometry, mapSize } from "./glass.ts";
import { themeIds, themes } from "./palettes.ts";
import { over } from "./surfaces.ts";
import { backdropExtremes } from "./backdrops.ts";
import { themeAccent } from "./accent.ts";
import { defaultTranslucency, translucencyMax, translucencyStep } from "./translucency.ts";

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

/** Glass text levels: text and secondary text at AA over anything behind glass; quiet hints at 3:1. */
const levels = {
  "--glass-foreground": 4.5,
  "--glass-muted-foreground": 4.5,
  "--glass-subtle-foreground": 3,
};
const percent = (value: string | undefined) => Number.parseFloat(value ?? "") / 100;

/** The slider's least, middle and most translucent glass, and Solid. */
const sliderStops = [0, translucencyStep, translucencyMax / 2, translucencyMax];

test("text on glass reads at AA over blurred busy backdrops in every theme, light and dark, anywhere on the Translucency slider", () => {
  const failures: string[] = [];
  for (const id of themeIds)
    for (const scheme of ["light", "dark"] as const)
      for (const translucency of sliderStops) {
        const tokens = themeDeclarations(id, scheme, themeAccent, translucency);
        const glass = tint(tokens["--glass-tint"]);
        // What the page's backdrop filter makes of code, a white page, a photo and prose.
        const behind = backdropExtremes(Number.parseFloat(tokens["--glass-blur"] ?? ""), {
          saturate: percent(tokens["--glass-saturate"]),
          contrast: percent(tokens["--glass-contrast"]),
          brightness: percent(tokens["--glass-brightness"]),
        });
        const ink = parseOpaqueColor(tokens["--glass-foreground"]) ?? [0, 0, 0];
        for (const [backdrop, colour] of Object.entries(behind)) {
          const surface = over(glass.rgb, glass.alpha, colour);
          // A selected row's ink wash on top, the strongest wash text sits on.
          const selected = over(ink, scheme === "light" ? 0.07 : 0.08, surface);
          for (const [token, minimum] of Object.entries(levels)) {
            const text = parseOpaqueColor(tokens[token]);
            const ratio = text
              ? Math.min(contrastRatio(text, surface), contrastRatio(text, selected))
              : 0;
            if (ratio < minimum)
              failures.push(
                `${id} ${scheme} at ${translucency}: ${token} on glass over the ${backdrop} backdrop ${ratio.toFixed(2)}`,
              );
          }
        }
      }
  expect(failures).toEqual([]);
});

test("glass text is stronger than the same level on solid surfaces", () => {
  for (const id of themeIds)
    for (const scheme of ["light", "dark"] as const) {
      const tokens = themeDeclarations(id, scheme);
      const page = parseOpaqueColor(tokens["--surface-2"]) ?? [0, 0, 0];
      for (const [solid, glass] of [
        ["--foreground", "--glass-foreground"],
        ["--muted-foreground", "--glass-muted-foreground"],
        ["--subtle-foreground", "--glass-subtle-foreground"],
      ] as const) {
        const on = (token: string) => contrastRatio(parseOpaqueColor(tokens[token]) ?? page, page);
        expect(on(glass), `${id} ${scheme} ${glass}`).toBeGreaterThanOrEqual(on(solid));
      }
    }
});

test("the slider runs from a solid tint with no blur to the theme's AA-safe glass", () => {
  for (const id of themeIds)
    for (const scheme of ["light", "dark"] as const) {
      const at = (translucency: number) => {
        const tokens = themeDeclarations(id, scheme, themeAccent, translucency);
        return {
          alpha: tint(tokens["--glass-tint"]).alpha,
          blur: Number.parseFloat(tokens["--glass-blur"] ?? ""),
          saturate: Number.parseFloat(tokens["--glass-saturate"] ?? ""),
          // The luminosity scrim: how far the backdrop's range is pulled toward the glass.
          scrim: Math.abs(1 - percent(tokens["--glass-contrast"])),
          dim: Math.abs(1 - percent(tokens["--glass-brightness"])),
        };
      };
      const solid = at(0);
      expect([id, scheme, solid]).toEqual([
        id,
        scheme,
        { alpha: 1, blur: 0, saturate: 100, scrim: 0, dim: 0 },
      ]);
      // The most translucent end is the floor the theme was solved for, and the default.
      const most = at(translucencyMax);
      expect(most).toEqual(at(defaultTranslucency));
      expect(most.alpha, `${id} ${scheme}`).toBe(themes[id][scheme].glassTint);
      // Each step toward it is thinner, blurrier and more saturated, never the other way.
      let previous = solid;
      for (
        let translucency = translucencyStep;
        translucency <= translucencyMax;
        translucency += translucencyStep
      ) {
        const next = at(translucency);
        expect(next.alpha).toBeLessThanOrEqual(previous.alpha);
        expect(next.blur).toBeGreaterThanOrEqual(previous.blur);
        expect(next.saturate).toBeGreaterThanOrEqual(previous.saturate);
        expect(next.scrim).toBeGreaterThanOrEqual(previous.scrim);
        expect(next.dim).toBeGreaterThanOrEqual(previous.dim);
        previous = next;
      }
    }
});

test("the most translucent glass clearly shows what's behind it, and Signal has none", () => {
  // At most 60% tint in light and 70% in dark: well over a third of the backdrop shows through.
  const thickest = { light: 0.6, dark: 0.7 };
  for (const id of themeIds)
    for (const scheme of ["light", "dark"] as const) {
      const { alpha } = tint(themeDeclarations(id, scheme)["--glass-tint"]);
      if (themes[id][scheme].material.glass)
        expect(alpha, `${id} ${scheme}`).toBeLessThanOrEqual(thickest[scheme]);
      else expect(alpha, `${id} ${scheme}`).toBe(1);
    }
});

test("the middle of the slider is genuinely in between: well over half the glass of the far end", () => {
  for (const id of themeIds)
    for (const scheme of ["light", "dark"] as const) {
      if (!themes[id][scheme].material.glass) continue;
      const shows = (translucency: number) =>
        1 - tint(themeDeclarations(id, scheme, themeAccent, translucency)["--glass-tint"]).alpha;
      const ratio = shows(translucencyMax / 2) / shows(translucencyMax);
      expect(ratio, `${id} ${scheme}`).toBeGreaterThan(0.6);
      expect(ratio, `${id} ${scheme}`).toBeLessThan(0.8);
    }
});
