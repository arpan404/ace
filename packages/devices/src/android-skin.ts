import type { DeviceChrome } from "@ace/protocol/devices";

/*
 * An Android emulator skin's look: its `layout` file (a tree of `name { ... }` blocks and
 * `key value` lines) says the portrait picture, the screen's shape and where the display sits
 * in it. Pure: the layout text and a reader for the images it names (decoded, so their shapes
 * can be measured) come in.
 */

export interface LayoutNode {
  values: Map<string, string>;
  children: Map<string, LayoutNode>;
}

const emptyNode = (): LayoutNode => ({ values: new Map(), children: new Map() });

/** The layout file as a tree. Lines it can't read are skipped. */
export function parseSkinLayout(text: string): LayoutNode {
  const root = emptyNode();
  const stack = [root];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const current = stack[stack.length - 1] ?? root;
    if (line === "}") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const open = /^(\S+)\s*\{$/.exec(line);
    if (open?.[1]) {
      const child = current.children.get(open[1]) ?? emptyNode();
      current.children.set(open[1], child);
      if (stack.length < 32) stack.push(child);
      continue;
    }
    const pair = /^(\S+)\s+(.+)$/.exec(line);
    if (pair?.[1] && pair[2]) current.values.set(pair[1], pair[2].trim());
  }
  return root;
}

const child = (node: LayoutNode | undefined, ...path: string[]) =>
  path.reduce<LayoutNode | undefined>((at, key) => at?.children.get(key), node);
const number = (node: LayoutNode | undefined, key: string) => {
  const value = Number(node?.values.get(key));
  return Number.isFinite(value) ? value : undefined;
};
const fileName = (value: string | undefined) =>
  value && /^[^/\\\0]+\.(?:webp|png)$/i.test(value) ? value : undefined;

/** One of the skin's images: as a data URL, and how opaque it is at a pixel (0 to 255). */
export interface SkinImage {
  url: string;
  /** Undefined when the image couldn't be decoded or the pixel is outside it. */
  alpha(x: number, y: number): number | undefined;
}

/** Reads one of the skin's images, or undefined. */
export type SkinImageReader = (file: string) => Promise<SkinImage | undefined>;

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * The radius of a rounded corner, found by walking in from it along the diagonal while the
 * picture stays opaque: a circle's corner leaves r·(1 − 1/√2) of it on the diagonal.
 */
export function cornerRadius(
  image: SkinImage,
  corner: { x: number; y: number },
  limit: number,
): number | undefined {
  const reach = Math.floor(limit * (1 - Math.SQRT1_2));
  for (let step = 0; step <= reach; step++) {
    const alpha = image.alpha(corner.x + step, corner.y + step);
    if (alpha === undefined) return undefined;
    if (alpha < 128) return step === 0 ? 0 : step / (1 - Math.SQRT1_2);
  }
  return undefined;
}

/** The share of the screen's short side each part of the drawn body takes. */
const bezelShare = 0.024;
const metalShare = 0.007;
/** A screen whose corners can't be measured is rounded this much of its short side. */
const fallbackRadiusShare = 0.05;

const svgUrl = (svg: string) =>
  `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;

/**
 * The body around a screen of `width` × `height` with corners of `radius`: one thin, even bezel
 * of black glass inside a graphite band with a soft lit edge, concentric with the screen's
 * corners. All the real hardware shows from the front; the screen itself is cut out.
 */
export function drawnBody(width: number, height: number, radius: number) {
  const short = Math.min(width, height);
  const bezel = Math.max(4, Math.round(short * bezelShare));
  const metal = Math.max(2, Math.round(short * metalShare));
  const edge = Math.max(1, short * 0.0018);
  const W = width + 2 * bezel;
  const H = height + 2 * bezel;
  const R = radius + bezel;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<defs><linearGradient id="band" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0" stop-color="#55555b"/><stop offset="0.5" stop-color="#2c2c30"/><stop offset="1" stop-color="#46464b"/>`,
    `</linearGradient></defs>`,
    `<rect width="${W}" height="${H}" rx="${round(R)}" fill="url(#band)"/>`,
    `<rect x="${round(edge / 2)}" y="${round(edge / 2)}" width="${round(W - edge)}" height="${round(H - edge)}" rx="${round(R - edge / 2)}" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="${round(edge)}"/>`,
    `<rect x="${metal}" y="${metal}" width="${W - 2 * metal}" height="${H - 2 * metal}" rx="${round(R - metal)}" fill="#050506"/>`,
    `</svg>`,
  ].join("");
  return { width: W, height: H, bezel, image: svgUrl(svg) };
}

/** The screen's shape: a rounded rectangle the live picture is clipped to. */
function screenMask(width: number, height: number, radius: number): string {
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><rect width="${width}" height="${height}" rx="${round(radius)}" fill="#000"/></svg>`,
  );
}

/**
 * The skin's upright look (its portrait layout, or, for a skin with no portrait layout such as
 * a tablet's, its first layout: its natural way up). The skin's own picture is a rendering with
 * extra rails and a wide glass ring, so the body is drawn instead from the skin's real geometry:
 * the display's size, the corner radius of the skin's screen opening, and the camera hole the
 * skin's mask draws over the display. Undefined when the layout has none usable.
 */
export async function androidSkinChrome(
  layout: string,
  read: SkinImageReader,
): Promise<DeviceChrome | undefined> {
  const tree = parseSkinLayout(layout);
  const layouts = child(tree, "layouts");
  const portrait = layouts?.children.get("portrait") ?? [...(layouts?.children.values() ?? [])][0];
  const width = number(portrait, "width");
  const height = number(portrait, "height");
  if (!portrait || !width || !height || width <= 0 || height <= 0) return undefined;
  const parts = [...portrait.children.values()].filter((node) => node.values.has("name"));
  const device = parts.find((part) => part.values.get("name") === "device");
  const backdrop = parts.find((part) => part.values.get("name") !== "device");
  if (!device || !backdrop || (number(device, "rotation") ?? 0) !== 0) return undefined;
  // The picture fills the layout; a skin that offsets it isn't one ace draws.
  if ((number(backdrop, "x") ?? 0) !== 0 || (number(backdrop, "y") ?? 0) !== 0) return undefined;
  const look = child(tree, "parts", backdrop.values.get("name") ?? "");
  const display = child(tree, "parts", "device", "display");
  const opening = {
    x: (number(device, "x") ?? 0) + (number(display, "x") ?? 0),
    y: (number(device, "y") ?? 0) + (number(display, "y") ?? 0),
    width: number(display, "width") ?? 0,
    height: number(display, "height") ?? 0,
  };
  if (opening.width <= 0 || opening.height <= 0) return undefined;
  const backgroundFile = fileName(child(look, "background")?.values.get("image"));
  const maskFile = fileName(child(look, "foreground")?.values.get("mask"));
  if (!backgroundFile) return undefined;
  const [backdropImage, mask] = await Promise.all([
    read(backgroundFile),
    maskFile ? read(maskFile) : undefined,
  ]);
  if (!backdropImage) return undefined;
  const short = Math.min(opening.width, opening.height);
  // The mask is opaque over the display's rounded corners; the picture, over the glass around
  // the opening. Either one's corner says how round the screen is.
  const radius =
    (mask && cornerRadius(mask, { x: 0, y: 0 }, short / 2)) ||
    cornerRadius(backdropImage, opening, short / 2) ||
    short * fallbackRadiusShare;
  const body = drawnBody(opening.width, opening.height, radius);
  const screen = {
    x: body.bezel,
    y: body.bezel,
    width: opening.width,
    height: opening.height,
  };
  return {
    body: { width: body.width, height: body.height, image: body.image },
    screen,
    mask: screenMask(opening.width, opening.height, radius),
    // The skin's "mask" is drawn over the display, as the emulator draws it: opaque over the
    // rounded corners and the camera hole, clear over the screen. So it's a cutout, not a mask.
    ...(mask ? { cutout: { rect: screen, image: mask.url } } : {}),
    buttons: [],
  };
}
