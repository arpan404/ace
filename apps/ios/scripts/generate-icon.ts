import { DesignTokensSchema } from "@ace/design-tokens";
import data from "@ace/design-tokens/tokens.json" with { type: "json" };
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/**
 * Writes the iOS app icon and launch colour into `Resources/Assets.xcassets`:
 *
 *   bun scripts/generate-icon.ts
 *
 * The glyph is the ace mark from the desktop master, `apps/desktop/build/icon.svg`: a ring
 * whose right side is an upright stem, rounded at the top and cut square at the baseline.
 * iOS masks the icon itself, so the tile here is full bleed and the glyph is scaled from the
 * desktop's 824 px tile to the 1024 px canvas. Rendering is analytic with fixed supersampling,
 * so the output is byte-identical on every run. The outputs are committed; rerun after changes.
 */
const size = 1024;
const samples = 4;
const catalog = join(import.meta.dirname, "..", "Resources", "Assets.xcassets");

// Glyph geometry in the desktop master's coordinates (its tile spans 100..924).
const ring = { x: 506, y: 512, outer: 180, inner: 91 };
const stem = { left: 597, right: 686, capY: 376.5, bottom: 692 };
const capRadius = (stem.right - stem.left) / 2;
const glyphCentre = { x: (ring.x - ring.outer + stem.right) / 2, y: ring.y };
const scale = size / 824;

type Rgb = readonly [number, number, number];

function hex(value: string): Rgb {
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// The desktop master's tile and ink gradients, top to bottom.
const tile: ReadonlyArray<readonly [number, Rgb]> = [
  [0, hex("#2c2d31")],
  [0.45, hex("#17171a")],
  [1, hex("#0a0a0b")],
];
const ink: ReadonlyArray<readonly [number, Rgb]> = [
  [0, hex("#fbfbfc")],
  [1, hex("#cfd0d5")],
];
const white: ReadonlyArray<readonly [number, Rgb]> = [[0, [255, 255, 255]]];

function mix(from: Rgb, to: Rgb, k: number): Rgb {
  return [
    from[0] + (to[0] - from[0]) * k,
    from[1] + (to[1] - from[1]) * k,
    from[2] + (to[2] - from[2]) * k,
  ];
}

function gradient(stops: ReadonlyArray<readonly [number, Rgb]>, t: number): Rgb {
  const first = stops[0];
  if (first === undefined) throw new Error("empty gradient");
  let previous = first;
  for (const stop of stops) {
    if (t <= stop[0]) {
      const span = stop[0] - previous[0];
      const k = span === 0 ? 0 : (t - previous[0]) / span;
      return mix(previous[1], stop[1], k);
    }
    previous = stop;
  }
  return previous[1];
}

/** Whether a canvas point lies inside the glyph. */
function inGlyph(cx: number, cy: number): boolean {
  const x = (cx - size / 2) / scale + glyphCentre.x;
  const y = (cy - size / 2) / scale + glyphCentre.y;
  const r = Math.hypot(x - ring.x, y - ring.y);
  if (r <= ring.outer && r >= ring.inner) return true;
  if (x < stem.left || x > stem.right || y > stem.bottom) return false;
  if (y >= stem.capY) return true;
  return Math.hypot(x - (stem.left + capRadius), y - stem.capY) <= capRadius;
}

/** Fraction of the pixel at (px, py) the glyph covers. */
function coverage(px: number, py: number): number {
  let hits = 0;
  for (let sy = 0; sy < samples; sy++)
    for (let sx = 0; sx < samples; sx++)
      if (inGlyph(px + (sx + 0.5) / samples, py + (sy + 0.5) / samples)) hits++;
  return hits / (samples * samples);
}

// Glyph's vertical extent on the canvas, for the ink gradient.
const glyphTop = size / 2 + (stem.capY - capRadius - glyphCentre.y) * scale;
const glyphBottom = size / 2 + (stem.bottom - glyphCentre.y) * scale;

interface Variant {
  file: string;
  /** Tile colour by height, or null for a transparent tile. */
  background: ReadonlyArray<readonly [number, Rgb]> | null;
  glyph: ReadonlyArray<readonly [number, Rgb]>;
}

function render(variant: Variant): Buffer {
  const channels = variant.background === null ? 4 : 3;
  const stride = 1 + size * channels;
  const raw = Buffer.alloc(stride * size);
  for (let py = 0; py < size; py++) {
    const row = py * stride;
    raw[row] = 0; // filter: none
    const back = variant.background && gradient(variant.background, (py + 0.5) / size);
    const t = Math.min(1, Math.max(0, (py + 0.5 - glyphTop) / (glyphBottom - glyphTop)));
    const fore = gradient(variant.glyph, t);
    for (let px = 0; px < size; px++) {
      const a = coverage(px, py);
      const at = row + 1 + px * channels;
      const [red, green, blue] = back ? mix(back, fore, a) : fore;
      raw[at] = Math.round(red);
      raw[at + 1] = Math.round(green);
      raw[at + 2] = Math.round(blue);
      if (channels === 4) raw[at + 3] = Math.round(a * 255);
    }
  }
  return png(raw, channels === 4 ? 6 : 2);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (crcTable[(c ^ byte) & 255] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(typed));
  return Buffer.concat([head, typed, tail]);
}

/** An 8-bit PNG; colour type 2 is RGB (no alpha), 6 is RGBA. */
function png(raw: Buffer, colourType: 2 | 6): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = colourType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Apple: the default icon is opaque; the dark one lets the system draw its dark tile behind
// the glyph; the tinted one is grayscale, which the system recolours.
const variants: Variant[] = [
  { file: "AppIcon.png", background: tile, glyph: ink },
  { file: "AppIcon-Dark.png", background: null, glyph: ink },
  { file: "AppIcon-Tinted.png", background: [[0, [0, 0, 0]]], glyph: white },
];

const universal = (filename: string, appearances?: object[]) => ({
  filename,
  idiom: "universal",
  platform: "ios",
  size: "1024x1024",
  ...(appearances ? { appearances } : {}),
});
const author = { author: "xcode", version: 1 };
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const iconSet = join(catalog, "AppIcon.appiconset");
await mkdir(iconSet, { recursive: true });
for (const variant of variants) {
  await writeFile(join(iconSet, variant.file), render(variant));
  console.log(`[icon] ${join(iconSet, variant.file)}`);
}
await writeFile(
  join(iconSet, "Contents.json"),
  json({
    images: [
      universal("AppIcon.png"),
      universal("AppIcon-Dark.png", [{ appearance: "luminosity", value: "dark" }]),
      universal("AppIcon-Tinted.png", [{ appearance: "luminosity", value: "tinted" }]),
    ],
    info: author,
  }),
);

// The launch screen is the inbox's background colour, light and dark, from the design tokens.
const tokens = DesignTokensSchema.parse(data);
const components = (value: string) => {
  const [red, green, blue] = hex(value).map(
    (n) => `0x${n.toString(16).toUpperCase().padStart(2, "0")}`,
  );
  return {
    color: { "color-space": "srgb", components: { red, green, blue, alpha: "1.000" } },
    idiom: "universal",
  };
};
const launch = join(catalog, "LaunchBackground.colorset");
await mkdir(launch, { recursive: true });
await writeFile(
  join(launch, "Contents.json"),
  json({
    colors: [
      components(tokens.schemes.light.colours.background),
      {
        ...components(tokens.schemes.dark.colours.background),
        appearances: [{ appearance: "luminosity", value: "dark" }],
      },
    ],
    info: author,
  }),
);
await writeFile(join(catalog, "Contents.json"), json({ info: author }));
console.log(`[icon] ${launch}`);
