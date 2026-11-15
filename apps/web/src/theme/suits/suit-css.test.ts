import { describe, expect, it } from "vitest";
import { fakeSuit } from "@/test/fake-suits.ts";
import { themeDeclarations } from "../css.ts";
import { suitDeclarations, suitFontSources, suitStylesheet } from "./suit-css.ts";

const synthwave = fakeSuit({
  id: "synthwave",
  base: "midnight",
  dark: {
    canvas: "#1a0b2e",
    sidebar: "#140824",
    accent: "#ff3ea5",
    // Not a field a Suit may set: kept as raw data by the schema, never applied.
    working: "#00ff00",
    failed: "#00ff00",
  },
});

describe("a Suit's colours over its base theme", () => {
  it("replaces the page, sidebar and accent with the Suit's", () => {
    const tokens = suitDeclarations(synthwave, "dark");
    expect(tokens["--background"]).toBe("#1a0b2e");
    expect(tokens["--sidebar"]).toBe("#140824");
    expect(tokens["--ring"]).not.toBe(themeDeclarations("midnight", "dark")["--ring"]);
  });

  it("keeps status, row status and danger as ace's own, whatever the file says", () => {
    const tokens = suitDeclarations(synthwave, "dark");
    const base = themeDeclarations("midnight", "dark");
    const owned = Object.keys(base).filter(
      (name) =>
        (name.startsWith("--status-") && !name.endsWith("-text")) ||
        name.startsWith("--row-status-") ||
        name === "--danger",
    );
    expect(owned.length).toBeGreaterThan(8);
    for (const name of owned) expect([name, tokens[name]]).toEqual([name, base[name]]);
  });

  it("fills every colour it leaves out from the base theme", () => {
    expect(suitDeclarations(synthwave, "dark")["--syn-kw"]).toBe(
      themeDeclarations("midnight", "dark")["--syn-kw"],
    );
  });

  it("draws a one-scheme Suit in its own scheme when the page asks for the other", () => {
    const light = suitDeclarations(synthwave, "light");
    expect(light["color-scheme"]).toBe("dark");
    expect(light["--background"]).toBe("#1a0b2e");
    const sheet = suitStylesheet(synthwave);
    expect(sheet).toContain('[data-suit="synthwave"][data-scheme="light"]');
    expect(sheet).toContain('[data-suit="synthwave"][data-scheme="dark"]');
  });
});

describe("a Suit's shape, motion and fonts", () => {
  it("scales the corner and duration tokens and sets the hairline weight", () => {
    const suit = fakeSuit({
      id: "round",
      dark: {},
      shape: { radius: 1.5, border: 2 },
      motion: { speed: 0.5 },
    });
    expect(suitDeclarations(suit, "dark")).toMatchObject({
      "--radius-scale": "1.5",
      "--border-weight": "2px",
      "--motion-scale": "0.5",
    });
  });

  it("loads a bundled font from its served URL and falls back to the base stack", () => {
    const suit = {
      ...fakeSuit({
        id: "typed",
        dark: {},
        fonts: { ui: { asset: "assets/inter.woff2", family: "Inter" } },
      }),
      assets: { "assets/inter.woff2": "https://daemon.local/suits/typed/assets/inter.woff2" },
    };
    const sheet = suitStylesheet(suit);
    expect(sheet).toContain(
      '@font-face{font-family:"ace-suit-typed-ui";src:url("https://daemon.local/suits/typed/assets/inter.woff2") format("woff2")',
    );
    expect(suitDeclarations(suit, "dark")["--font-sans"]).toMatch(/^"ace-suit-typed-ui", /);
  });

  it("uses a system stack as given, ahead of the base fonts", () => {
    const suit = fakeSuit({
      id: "serif",
      dark: {},
      fonts: { prose: { system: '"Iowan Old Style", Georgia, serif' } },
    });
    expect(suitDeclarations(suit, "dark")["--font-prose"]).toMatch(
      /^"Iowan Old Style", Georgia, serif, /,
    );
  });

  it("never lets a font value write CSS of its own or load a remote file", () => {
    const base = themeDeclarations("ace", "dark");
    const escaping = fakeSuit({
      id: "escape",
      dark: {},
      fonts: {
        ui: { system: "x;}body{background:url(https://evil.example/a.png)" },
        mono: { asset: "assets/a.woff2", family: "A" },
      },
    });
    const suit = { ...escaping, assets: { "assets/a.woff2": 'https://x/a.woff2") ; }body{' } };
    const sheet = suitStylesheet(suit);
    expect(sheet).not.toContain("evil.example");
    expect(sheet).not.toContain("@font-face");
    expect(suitDeclarations(suit, "dark")["--font-sans"]).toBe(base["--font-sans"]);
    expect(suitDeclarations(suit, "dark")["--font-mono"]).toBe(base["--font-mono"]);
  });
});

describe("the fonts a Suit bundles", () => {
  it("are every file from `fonts` and from suit.css's @font-face rules, each face apart", () => {
    const served = "http://127.0.0.1:4242/v1/suits/pixel/h/g/assets/";
    const pixel = {
      ...fakeSuit({
        id: "pixel",
        dark: { canvas: "#101014" },
        fonts: {
          ui: { asset: "assets/ui.woff2", family: "Pixel UI" },
          prose: { system: "Georgia, serif" },
        },
      }),
      assets: { "assets/ui.woff2": `${served}ui.woff2` },
      css: [
        `@layer suit{@font-face{font-family:"Arcade Display";src:url("${served}bold.ttf") format("truetype");font-weight:700}`,
        `@font-face{font-family:'Arcade Display';src:url(${served}regular.ttf);font-style:italic}`,
        // A face whose file isn't one a page may load is left out.
        `@font-face{font-family:"Bad";src:url("javascript:alert(1)")}}`,
      ].join("\n"),
    };
    expect(suitFontSources(pixel)).toEqual([
      { family: "ace-suit-pixel-ui", url: `${served}ui.woff2`, format: "woff2" },
      { family: "Arcade Display", url: `${served}bold.ttf`, format: "truetype", weight: "700" },
      {
        family: "Arcade Display",
        url: `${served}regular.ttf`,
        format: "truetype",
        style: "italic",
      },
    ]);
    // The tokens' faces wait briefly for a cached file rather than flashing a fallback.
    expect(suitStylesheet(pixel)).toContain("font-display:fallback");
  });
});
