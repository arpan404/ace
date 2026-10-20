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
 * The glyph is the ace mark from the desktop master, `apps/desktop/build/icon.svg`: two
 * mirrored wings gathered around an open diamond, on the mark's 24-unit grid. iOS masks the
 * icon itself, so the tile here is full bleed and the glyph keeps its size relative to the
 * desktop's 824 px tile. Rendering is analytic (flattened curves, exact horizontal coverage
 * over fixed sub-rows), so the output is byte-identical on every run. The outputs are
 * committed; rerun after changes.
 */
const size = 1024;
const subRows = 4;
const catalog = join(import.meta.dirname, "..", "Resources", "Assets.xcassets");

/** One wing on the 24-unit grid (apps/web/src/components/ace-mark.tsx); absolute commands only. */
const wing =
  "M11.6 2C10.8 2 10.4 2.6 9.8 3.3L2.9 11.3C1.2 13.3 1.8 15.6 3.8 16.8L7.8 19.3C8.5 19.8 9.3 19.8 9.9 19.1L11 17.7C11.7 16.8 11.5 16.1 10.8 15.4L7.3 12.3C10.3 9.8 11.6 7.6 11.6 5V2Z";
// The desktop master draws the grid at 31 px per unit on its 824 px tile, centred on (12, 10.9).
const unit = (31 * size) / 824;
const centre = { x: 12, y: 10.9 };
const glyphTop = size / 2 + (2 - centre.y) * unit;
const glyphBottom = size / 2 + (19.8 - centre.y) * unit;

type Point = readonly [number, number];

/** The path as a closed polygon in grid units, each cubic flattened into fixed steps. */
function flatten(path: string): Point[] {
  const tokens = path.match(/[A-Za-z]|-?\d*\.?\d+/g) ?? [];
  const points: Point[] = [];
  let at = 0;
  let command = "";
  const number = () => Number(tokens[at++]);
  let current: Point = [0, 0];
  while (at < tokens.length) {
    const token = tokens[at] ?? "";
    if (/[A-Za-z]/.test(token)) {
      command = token;
      at++;
    }
    if (command === "M" || command === "L") current = [number(), number()];
    else if (command === "V") current = [current[0], number()];
    else if (command === "H") current = [number(), current[1]];
    else if (command === "C") {
      const [x0, y0] = current;
      const [x1, y1, x2, y2, x3, y3] = [number(), number(), number(), number(), number(), number()];
      for (let step = 1; step < 32; step++) {
        const t = step / 32;
        const u = 1 - t;
        const a = u * u * u;
        const b = 3 * u * u * t;
        const c = 3 * u * t * t;
        const d = t * t * t;
        points.push([a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3]);
      }
      current = [x3, y3];
    } else if (command === "Z") continue;
    else throw new Error(`unsupported path command ${command}`);
    points.push(current);
  }
  return points;
}

/** Both wings' edges on the canvas. */
const edges: Array<readonly [Point, Point]> = [];
const outline = flatten(wing);
for (const mirror of [false, true]) {
  const canvas = outline.map(([x, y]): Point => [
    size / 2 + ((mirror ? 24 - x : x) - centre.x) * unit,
    size / 2 + (y - centre.y) * unit,
  ]);
  canvas.forEach((point, index) =>
    edges.push([point, canvas[(index + 1) % canvas.length] ?? point]),
  );
}

/** Fraction of each pixel in row `py` the glyph covers (even-odd fill). */
function rowCoverage(py: number): Float64Array {
  const cover = new Float64Array(size);
  for (let sub = 0; sub < subRows; sub++) {
    const y = py + (sub + 0.5) / subRows;
    const crossings: number[] = [];
    for (const [[x0, y0], [x1, y1]] of edges)
      if (y0 <= y !== y1 <= y) crossings.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
    crossings.sort((a, b) => a - b);
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const from = Math.max(0, crossings[index] ?? 0);
      const to = Math.min(size, crossings[index + 1] ?? 0);
      for (let px = Math.floor(from); px < to; px++)
        cover[px] = (cover[px] ?? 0) + (Math.min(px + 1, to) - Math.max(px, from)) / subRows;
    }
  }
  return cover;
}

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
    const cover = rowCoverage(py);
    for (let px = 0; px < size; px++) {
      const a = cover[px] ?? 0;
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
