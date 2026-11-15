import { expect, test } from "vitest";
import { SuitManifest } from "@ace/protocol/suits";
import { sharedStatus, themes } from "@ace/themes";
import { contentHash, inspectSuit, plan, type SuitEntry } from "./folder.ts";
import { suitPalette } from "./palette.ts";
import { suitLimits } from "./limits.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const manifest = (fields: Record<string, unknown>) =>
  JSON.stringify({ format: 1, id: "neon", name: "Neon", ...fields });
const inspect = (files: Record<string, string>, id = "neon") => {
  const map = new Map(Object.entries(files).map(([path, text]) => [path, bytes(text)]));
  const entries: SuitEntry[] = [...map].map(([path, data]) => ({
    path,
    kind: "file",
    size: data.byteLength,
  }));
  return inspectSuit(id, map, plan(entries));
};
const checks = (files: Record<string, string>) =>
  inspect(files).summary.problems.map((problem) => problem.check);

test("a Suit that only recolours the dark canvas passes and runs in dark only", () => {
  const { summary } = inspect({ "suit.json": manifest({ dark: { canvas: "#101014" } }) });
  expect(summary.problems).toEqual([]);
  expect(summary.schemes).toEqual(["dark"]);
  expect(summary.scene).toBe(false);
});

test("status colours stay the base theme's whatever keys the Suit's file carries", () => {
  const suit = SuitManifest.parse(
    JSON.parse(manifest({ dark: { canvas: "#101014", working: "#FF00FF", failed: "#00FF00" } })),
  );
  const palette = suitPalette(suit, "dark");
  expect(palette.s0).toBe("#101014");
  expect(palette.working).toBe(themes.ace.dark.working);
  expect(palette.failed).toBe(themes.ace.dark.failed);
});

test("a Suit with no palette at all is told to set one", () => {
  const problems = inspect({ "suit.json": manifest({}) }).summary.problems;
  expect(problems).toEqual([expect.objectContaining({ check: "schema", field: null })]);
});

test("a bad colour is reported at its field and scheme", () => {
  const problems = inspect({ "suit.json": manifest({ light: { canvas: "white" } }) }).summary
    .problems;
  expect(problems).toEqual([
    expect.objectContaining({ check: "schema", field: "light.canvas", scheme: "light" }),
  ]);
});

test("a manifest naming another folder's id is refused", () => {
  const { summary, manifest: parsed } = inspect({ "suit.json": manifest({ dark: {} }) }, "other");
  expect(summary.problems.map((problem) => problem.field)).toEqual(["id"]);
  expect(parsed?.id).toBe("neon");
});

test("suit.json that isn't JSON leaves the Suit listed by its folder name", () => {
  const { summary, manifest: parsed } = inspect({ "suit.json": "{ nope" });
  expect(parsed).toBeUndefined();
  expect(summary.name).toBe("neon");
  expect(summary.problems[0]?.check).toBe("schema");
});

test("an accent that can't be told from the page fails contrast", () => {
  const dark = {
    canvas: "#101010",
    accent: "#1A1A1A",
    accentHover: "#202020",
    accentFg: "#FFFFFF",
    accentText: "#FFFFFF",
  };
  const problems = inspect({ "suit.json": manifest({ dark }) }).summary.problems;
  expect(problems).toContainEqual(
    expect.objectContaining({ check: "contrast", field: "accent", scheme: "dark" }),
  );
});

test("an accent the colour of a status mark fails accent fit", () => {
  const accent = themes.ace.light.working;
  const light = { accent, accentHover: accent, accentFg: "#FFFFFF", accentText: accent };
  expect(checks({ "suit.json": manifest({ light }) })).toContain("accent-fit");
});

test("an accent near the waiting violet fails accent fit even when ace would fit the rest", () => {
  const accent = sharedStatus.dark.waiting;
  expect(checks({ "suit.json": manifest({ dark: { accent } }) })).toContain("accent-fit");
});

test("glass whose text can't read at any thinness fails the glass floor", () => {
  const dark = { raised: "#7A7A7A", text: "#858585", muted: "#828282", subtle: "#808080" };
  expect(checks({ "suit.json": manifest({ dark }) })).toContain("glass-floor");
});

test("solid layers (glass null) have no glass floor to fail", () => {
  const dark = { raised: "#7A7A7A", text: "#858585", glass: null };
  expect(checks({ "suit.json": manifest({ dark }) })).not.toContain("glass-floor");
});

test("a font naming a missing file is reported; a bundled one passes", () => {
  const fonts = { ui: { asset: "assets/inter.woff2", family: "Inter" } };
  const json = manifest({ dark: {}, fonts });
  expect(inspect({ "suit.json": json }).summary.problems).toEqual([
    expect.objectContaining({ check: "asset", field: "assets/inter.woff2" }),
  ]);
  expect(inspect({ "suit.json": json, "assets/inter.woff2": "font" }).summary.problems).toEqual([]);
});

test("scene is set from scene.js on disk, not from the file's claim", () => {
  const claimed = inspect({ "suit.json": manifest({ dark: {}, scene: true }) });
  expect(claimed.summary.scene).toBe(false);
  expect(claimed.manifest?.scene).toBe(false);
  const real = inspect({ "suit.json": manifest({ dark: {} }), "scene.js": "draw()" });
  expect(real.summary.scene).toBe(true);
  expect(real.manifest?.scene).toBe(true);
});

test("links are never read, and oversized files are refused by size", () => {
  const result = plan([
    { path: "suit.json", kind: "file", size: 100 },
    { path: "scene.js", kind: "file", size: suitLimits.sceneBytes + 1 },
    { path: "assets", kind: "directory", size: 0 },
    { path: "assets/escape.png", kind: "symlink", size: 0 },
    { path: "assets/a.png", kind: "file", size: suitLimits.assetBytes },
    { path: "assets/b.png", kind: "file", size: 1 },
  ]);
  expect(result.read).toEqual(["assets/a.png", "suit.json"]);
  expect(result.problems.map((problem) => problem.field)).toEqual([
    "assets/b.png",
    "assets/escape.png",
    "scene.js",
  ]);
});

test("suit.css over its cap is refused unread, as a css problem", () => {
  const result = plan([
    { path: "suit.json", kind: "file", size: 100 },
    { path: "suit.css", kind: "file", size: suitLimits.cssBytes + 1 },
  ]);
  expect(result.read).toEqual(["suit.json"]);
  expect(result.problems).toEqual([expect.objectContaining({ check: "css", field: "suit.css" })]);
});

test("a refused suit.css rule stops the Suit applying, with its line", () => {
  const result = inspect({
    "suit.json": manifest({ dark: { canvas: "#101014" } }),
    "suit.css": "[data-part=rail] { color: red }\n\n#main { color: red }",
  });
  expect(result.summary.problems).toEqual([
    expect.objectContaining({ check: "css", field: "suit.css", line: 3 }),
  ]);
});

test("a folder without suit.json says so", () => {
  expect(plan([]).problems).toEqual([expect.objectContaining({ field: "suit.json" })]);
});

const hash = (files: Record<string, string>) =>
  contentHash(new Map(Object.entries(files).map(([path, text]) => [path, bytes(text)])));

test("the content hash changes with any byte and frames paths and contents apart", () => {
  const base = hash({ "suit.json": "{}", "scene.js": "a" });
  expect(hash({ "scene.js": "a", "suit.json": "{}" })).toBe(base);
  expect(hash({ "suit.json": "{}", "scene.js": "b" })).not.toBe(base);
  expect(hash({ a: "bc" })).not.toBe(hash({ ab: "c" }));
  expect(hash({ a: "", b: "" })).not.toBe(hash({ a: "b" }));
  expect(contentHash(new Map(), [{ path: "scene.js", size: 1 }])).not.toBe(
    contentHash(new Map(), [{ path: "scene.js", size: 2 }]),
  );
});
