import { expect, test } from "vitest";
import { SuitManifest, type SuitProblem, type SuitSummary } from "@ace/protocol/suits";
import { phoneSuit, phoneSuitRow, stackFamilies, stillTint } from "./phone.ts";

const summary = (problems: SuitProblem[] = []): SuitSummary => ({
  id: "neon",
  name: "Neon",
  description: "Pink on black",
  schemes: ["dark"],
  scene: false,
  contentHash: "a".repeat(64),
  problems,
});
const detail = (fields: Record<string, unknown>, problems: SuitProblem[] = []) => ({
  summary: summary(problems),
  manifest: SuitManifest.parse({ format: 1, id: "neon", name: "Neon", ...fields }),
});
const problem = (message: string): SuitProblem => ({
  scheme: "dark",
  check: "contrast",
  field: "muted",
  message,
});

test("a dark-only Suit draws its own page colour in light mode too", () => {
  const suit = phoneSuit(detail({ dark: { canvas: "#101014" } }));
  expect(suit.schemes).toEqual(["dark"]);
  expect(suit.colours.dark.background).toBe("#101014");
  expect(suit.colours.light.background).toBe("#101014");
  expect(suit.unavailable).toBeNull();
});

test("a Suit the daemon's checks refused can't be shown, and says why", () => {
  const refused = detail({ dark: { canvas: "#101014" } }, [
    problem("muted reads at 2.1:1 on canvas"),
    problem("faint reads at 1.4:1 on canvas"),
  ]);
  expect(phoneSuit(refused).unavailable).toBe("muted reads at 2.1:1 on canvas (and 1 more)");
  expect(phoneSuitRow(refused.summary).unavailable).toBe(
    "muted reads at 2.1:1 on canvas (and 1 more)",
  );
});

test("colours that wouldn't read on the phone's surfaces fall back, naming the colour", () => {
  // A dark pressed fill on a light page: the phone draws its rows' words on that fill.
  const suit = phoneSuit(detail({ light: { canvas: "#FFFFFF", active: "#222222" } }));
  expect(suit.unavailable).toMatch(/^Its foreground reads at \d\.\d:1 in light on this phone/);
});

test("a bundled font is registered from its file, a system stack by its installed names", () => {
  const suit = phoneSuit(
    detail({
      dark: {},
      fonts: {
        ui: { system: `"Tarn Sans", 'Hanken Grotesk', system-ui, sans-serif` },
        prose: { system: "ui-serif, serif" },
        mono: { asset: "assets/fonts/Commit.woff2", family: "Tarn Mono" },
      },
    }),
  );
  expect(suit.fonts.ui).toEqual({ asset: null, families: ["Tarn Sans", "Hanken Grotesk"] });
  expect(suit.fonts.prose).toBeNull();
  expect(suit.fonts.mono).toEqual({ asset: "assets/fonts/Commit.woff2", families: ["Tarn Mono"] });
});

test("a font file a phone can't load is left to the system font", () => {
  const suit = phoneSuit(
    detail({ dark: {}, fonts: { ui: { asset: "assets/fonts/face.svg", family: "Face" } } }),
  );
  expect(suit.fonts.ui).toBeNull();
});

test("a Suit's one still shows behind both schemes", () => {
  const suit = phoneSuit(detail({ dark: {}, thumbnail: { dark: "assets/still.webp" } }));
  expect(suit.stills).toEqual({ light: "assets/still.webp", dark: "assets/still.webp" });
  expect(phoneSuit(detail({ dark: {} })).stills).toEqual({ light: null, dark: null });
});

test("shape scales corners and hairlines, and Spacious draws as Comfortable", () => {
  const suit = phoneSuit(
    detail({ dark: {}, shape: { radius: 0.5, border: 1.5, density: "spacious" } }),
  );
  expect([suit.radius, suit.border, suit.density]).toEqual([0.5, 1.5, "comfortable"]);
  expect(phoneSuit(detail({ dark: {} })).density).toBeNull();
});

test("stacks lose their quotes and generic keywords", () => {
  expect(stackFamilies(`"A B", C ,monospace, -apple-system`)).toEqual(["A B", "C"]);
});

test("text reads over a still: a busy one needs a thicker page than a calm one", () => {
  const { colours } = phoneSuit(detail({ dark: { canvas: "#16181B" } }));
  const calm = stillTint(colours.dark, [
    [20, 22, 26],
    [30, 34, 40],
  ]);
  const busy = stillTint(colours.dark, [
    [20, 22, 26],
    [240, 240, 235],
  ]);
  expect(calm).toBe(0.4);
  expect(busy).toBeGreaterThan(calm);
  expect(busy).toBeLessThan(1);
  // A still no tint can save asks for the solid page.
  const { colours: light } = phoneSuit(detail({ light: { canvas: "#FFFFFF" } }));
  expect(stillTint(light.light, [[0, 0, 0]])).toBeGreaterThan(
    stillTint(light.light, [[250, 250, 250]]),
  );
});
