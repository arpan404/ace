import { z } from "zod";
import type { DeviceChrome, DeviceChromeButton, DeviceChromeRect } from "@ace/protocol/devices";
import { pdfArt, svgDocument, type SvgArt } from "./pdf-svg.ts";

/*
 * A Simulator's look from Apple's own files for its device type: the profile (screen size and
 * scale, the screen-shape PDF, the notch PDF, which chrome it wears) and that chrome's
 * description (nine body pieces, their stretch sizes, the buttons and where they sit). Pure:
 * the parsed files and a reader for the PDFs they name come in; the wire shape comes out.
 */

const size = z.number().finite().positive().max(100_000);
const offset = z.number().finite().min(-100_000).max(100_000);
const name = z.string().min(1).max(256);

/** The fields of a device type's profile.plist ace uses; every other one is ignored. */
export const SimulatorProfile = z.object({
  mainScreenWidth: size,
  mainScreenHeight: size,
  mainScreenScale: size,
  framebufferMask: name.optional().catch(undefined),
  sensorBarImage: name.optional().catch(undefined),
  chromeIdentifier: name.optional().catch(undefined),
});
export type SimulatorProfile = z.infer<typeof SimulatorProfile>;

const ChromeInput = z.object({
  name: z.string().min(1).max(64),
  accessibilityTitle: z.string().max(64).optional().catch(undefined),
  image: name,
  imageDown: name.optional().catch(undefined),
  onTop: z.boolean().optional().catch(undefined),
  anchor: z.enum(["left", "right", "top", "bottom"]),
  align: z.enum(["leading", "trailing", "center"]).catch("leading"),
  offsets: z.object({ normal: z.object({ x: offset, y: offset }) }),
});
type ChromeInput = z.infer<typeof ChromeInput>;

const pieces = [
  "topLeft",
  "top",
  "topRight",
  "right",
  "bottomRight",
  "bottom",
  "bottomLeft",
  "left",
] as const;
type Piece = (typeof pieces)[number];

/** The fields of a chrome bundle's chrome.json ace uses. A button it can't read is left out. */
export const SimulatorChromeFile = z.object({
  images: z.object({
    topLeft: name,
    top: name,
    topRight: name,
    right: name,
    bottomRight: name,
    bottom: name,
    bottomLeft: name,
    left: name,
    /** The fill behind the screen, stretched over the middle. */
    screen: name.optional().catch(undefined),
    sizing: z.object({
      leftWidth: z.number().finite().min(0).max(10_000),
      rightWidth: z.number().finite().min(0).max(10_000),
      topHeight: z.number().finite().min(0).max(10_000),
      bottomHeight: z.number().finite().min(0).max(10_000),
    }),
  }),
  inputs: z
    .array(z.unknown())
    .max(16)
    .catch([])
    .default([])
    .transform((inputs) =>
      inputs.flatMap((input) => {
        const parsed = ChromeInput.safeParse(input);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
});
export type SimulatorChromeFile = z.infer<typeof SimulatorChromeFile>;

/** Reads a PDF named by the profile (from the device type) or the chrome (from its bundle). */
export type ArtReader = (
  from: "profile" | "chrome",
  name: string,
) => Promise<Uint8Array | undefined>;

const round = (value: number) => Math.round(value * 1000) / 1000;
const svgUrl = (svg: string) =>
  `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
const artUrl = (art: SvgArt) => svgUrl(svgDocument(art));

/** One body piece placed in the body, stretched to `rect` (edges stretch, corners don't). */
function placed(art: SvgArt, rect: DeviceChromeRect): string {
  return `<svg x="${round(rect.x)}" y="${round(rect.y)}" width="${round(rect.width)}" height="${round(rect.height)}" viewBox="0 0 ${round(art.width)} ${round(art.height)}" preserveAspectRatio="none" overflow="hidden">${art.svg}</svg>`;
}

/**
 * The body drawn from its nine pieces around a screen of `screen` points: the corners at their
 * own size, the edges stretched between them, as Simulator lays them out.
 */
function bodyArt(
  art: Record<Piece, SvgArt> & { middle?: SvgArt | undefined },
  width: number,
  height: number,
): string {
  const { topLeft, top, topRight, right, bottomRight, bottom, bottomLeft, left, middle } = art;
  const parts = [
    ...(middle
      ? [
          placed(middle, {
            x: left.width,
            y: top.height,
            width: Math.max(0.001, width - left.width - right.width),
            height: Math.max(0.001, height - top.height - bottom.height),
          }),
        ]
      : []),
    // Edges tuck one unit under the corners drawn over them, so no seam shows where they meet.
    placed(top, {
      x: topLeft.width - 1,
      y: 0,
      width: Math.max(0.001, width - topLeft.width - topRight.width + 2),
      height: top.height,
    }),
    placed(bottom, {
      x: bottomLeft.width - 1,
      y: height - bottom.height,
      width: Math.max(0.001, width - bottomLeft.width - bottomRight.width + 2),
      height: bottom.height,
    }),
    placed(left, {
      x: 0,
      y: topLeft.height - 1,
      width: left.width,
      height: Math.max(0.001, height - topLeft.height - bottomLeft.height + 2),
    }),
    placed(right, {
      x: width - right.width,
      y: topRight.height - 1,
      width: right.width,
      height: Math.max(0.001, height - topRight.height - bottomRight.height + 2),
    }),
    placed(topLeft, { x: 0, y: 0, width: topLeft.width, height: topLeft.height }),
    placed(topRight, {
      x: width - topRight.width,
      y: 0,
      width: topRight.width,
      height: topRight.height,
    }),
    placed(bottomLeft, {
      x: 0,
      y: height - bottomLeft.height,
      width: bottomLeft.width,
      height: bottomLeft.height,
    }),
    placed(bottomRight, {
      x: width - bottomRight.width,
      y: height - bottomRight.height,
      width: bottomRight.width,
      height: bottomRight.height,
    }),
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(width)} ${round(height)}" width="${round(width)}" height="${round(height)}">${parts.join("")}</svg>`;
}

/**
 * Where a button sits on a body of `width` × `height`. Its anchor is the edge it stands on and
 * its offset says how far it reaches past that edge and where it runs along it: from the start
 * (leading), from the end (trailing), or from the middle (a home button on the face).
 */
export function buttonRect(
  input: Pick<ChromeInput, "anchor" | "align" | "offsets">,
  button: { width: number; height: number },
  body: { width: number; height: number },
): DeviceChromeRect {
  const { x, y } = input.offsets.normal;
  const along = (start: number, extent: number, length: number) =>
    input.align === "trailing"
      ? length + start - extent
      : input.align === "center"
        ? (length - extent) / 2 + start
        : start;
  const rect = (left: number, top: number) => ({
    x: left,
    y: top,
    width: button.width,
    height: button.height,
  });
  switch (input.anchor) {
    case "left":
      return rect(x - button.width, along(y, button.height, body.height));
    case "right":
      return rect(body.width + x, along(y, button.height, body.height));
    case "top":
      return rect(along(x, button.width, body.width), y - button.height);
    case "bottom":
      return rect(along(x, button.width, body.width), body.height + y);
  }
}

async function readArt(read: ArtReader, from: "profile" | "chrome", file: string, prefix: string) {
  const bytes = await read(from, file);
  return bytes ? pdfArt(bytes, prefix) : undefined;
}

/**
 * A Simulator's look, or undefined when its chrome can't be drawn (a piece missing or
 * unreadable). The screen mask and notch are added when the profile has them.
 */
export async function simulatorChrome(
  profile: SimulatorProfile,
  chrome: SimulatorChromeFile,
  read: ArtReader,
): Promise<DeviceChrome | undefined> {
  const screen = {
    width: profile.mainScreenWidth / profile.mainScreenScale,
    height: profile.mainScreenHeight / profile.mainScreenScale,
  };
  const { sizing } = chrome.images;
  const body = {
    width: screen.width + sizing.leftWidth + sizing.rightWidth,
    height: screen.height + sizing.topHeight + sizing.bottomHeight,
  };
  const drawn = await Promise.all(
    pieces.map(async (piece, index) => {
      const pieceArt = await readArt(read, "chrome", chrome.images[piece], `p${index}`);
      return pieceArt ? ([piece, pieceArt] as const) : undefined;
    }),
  );
  const bodyPieces = new Map(drawn.filter((entry) => entry !== undefined));
  const piece = (key: Piece) => bodyPieces.get(key);
  const topLeft = piece("topLeft");
  const top = piece("top");
  const topRight = piece("topRight");
  const right = piece("right");
  const bottomRight = piece("bottomRight");
  const bottom = piece("bottom");
  const bottomLeft = piece("bottomLeft");
  const left = piece("left");
  if (!topLeft || !top || !topRight || !right || !bottomRight || !bottom || !bottomLeft || !left)
    return undefined;
  const [middle, mask, sensorBar, buttons] = await Promise.all([
    chrome.images.screen ? readArt(read, "chrome", chrome.images.screen, "c") : undefined,
    profile.framebufferMask ? readArt(read, "profile", profile.framebufferMask, "m") : undefined,
    profile.sensorBarImage ? readArt(read, "profile", profile.sensorBarImage, "s") : undefined,
    Promise.all(
      chrome.inputs.map(async (input): Promise<DeviceChromeButton | undefined> => {
        const [image, pressed] = await Promise.all([
          readArt(read, "chrome", input.image, "b"),
          input.imageDown ? readArt(read, "chrome", input.imageDown, "d") : undefined,
        ]);
        if (!image) return undefined;
        return {
          name: input.name,
          ...(input.accessibilityTitle ? { title: input.accessibilityTitle } : {}),
          rect: buttonRect(input, image, body),
          image: artUrl(image),
          ...(pressed ? { pressed: artUrl(pressed) } : {}),
          onTop: input.onTop ?? false,
        };
      }),
    ),
  ]);
  return {
    body: {
      ...body,
      image: svgUrl(
        bodyArt(
          { topLeft, top, topRight, right, bottomRight, bottom, bottomLeft, left, middle },
          body.width,
          body.height,
        ),
      ),
    },
    screen: { x: sizing.leftWidth, y: sizing.topHeight, ...screen },
    ...(mask ? { mask: artUrl(mask) } : {}),
    ...(sensorBar
      ? {
          cutout: {
            rect: {
              x: sizing.leftWidth + (screen.width - sensorBar.width) / 2,
              y: sizing.topHeight,
              width: sensorBar.width,
              height: sensorBar.height,
            },
            image: artUrl(sensorBar),
          },
        }
      : {}),
    buttons: buttons.filter((button) => button !== undefined).slice(0, 8),
  };
}
