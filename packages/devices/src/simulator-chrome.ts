import { z } from "zod";
import type { DeviceChrome, DeviceChromeButton, DeviceChromeRect } from "@ace/protocol/devices";
import { pdfArt, svgDocument, type SvgArt } from "./pdf-svg.ts";
import { bodyLayout, svgBody, type BodyPainter, type BodyPiece } from "./simulator-body.ts";
import type { SimulatorPanel } from "./simulator-panels.ts";

/*
 * A Simulator's look from Apple's own files for one of its screens: the screen (its size, the
 * screen-shape PDF, the notch PDF, which chrome it wears) and that chrome's description (nine
 * body pieces, their stretch sizes, the buttons and where they sit). Pure: the parsed files and
 * a reader for the PDFs they name come in; the wire shape comes out.
 */

const offset = z.number().finite().min(-100_000).max(100_000);
const name = z.string().min(1).max(256);

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
type Piece = BodyPiece;

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
    /** The whole body in one drawing, for the screen size it was made for. */
    composite: name.optional().catch(undefined),
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

/** Reads a PDF named by the device type (a mask, a notch) or the chrome (from its bundle). */
export type ArtReader = (
  from: "profile" | "chrome",
  name: string,
) => Promise<Uint8Array | undefined>;

const svgUrl = (svg: string) =>
  `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
const artUrl = (art: SvgArt) => svgUrl(svgDocument(art));

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

/**
 * A side button's art lying along the edge it stands on. Some chromes (an iPhone Duo's inner
 * panel) draw their buttons for the body turned a quarter, so a rocker anchored to the left
 * edge comes long side across; turned back, it lies along the edge as the hardware does.
 */
export function alongEdge(art: SvgArt, input: Pick<ChromeInput, "anchor" | "onTop">): SvgArt {
  if (input.onTop) return art;
  const upright = input.anchor === "left" || input.anchor === "right";
  const across = upright ? art.width > art.height * 1.5 : art.height > art.width * 1.5;
  if (!across) return art;
  return {
    width: art.height,
    height: art.width,
    svg: `<g transform="translate(${art.height} 0) rotate(90)">${art.svg}</g>`,
  };
}

async function readArt(read: ArtReader, from: "profile" | "chrome", file: string, prefix: string) {
  const bytes = await read(from, file);
  return bytes ? pdfArt(bytes, prefix) : undefined;
}

interface Frame {
  body: { width: number; height: number };
  /** Where the screen's top left corner sits in the body. */
  origin: { x: number; y: number };
  /**
   * The screen's size in body units, when the body was drawn for a screen of the same shape
   * but another size; absent, the screen's own size in points.
   */
  screen?: { width: number; height: number };
  image: string;
}

/**
 * How far a composite may differ from the sliced body's size and still be the drawing made for
 * this screen (Apple's composites can sit a point inside the stretch sizes).
 */
const compositeSlack = 4;

/** How far a composite's screen opening may differ in shape from the screen's, as a share. */
const shapeSlack = 0.01;

/**
 * The body as the chrome's single composite drawing, seamless, as Simulator shows it: when it
 * was made for a screen this size, the screen sits where the stretch sizes put it, scaled to
 * the composite's own margins. A composite made for a screen of the same shape but another size
 * (an iPhone Duo's inner panel wears one) is used whole, its opening standing for the screen:
 * only proportions matter. Newer chromes ship nothing else worth drawing, their nine pieces
 * being blank placeholders.
 */
async function compositeFrame(
  chrome: SimulatorChromeFile,
  screen: { width: number; height: number },
  read: ArtReader,
): Promise<Frame | undefined> {
  const { composite, sizing } = chrome.images;
  if (!composite) return undefined;
  const art = await readArt(read, "chrome", composite, "w");
  if (!art) return undefined;
  const across = sizing.leftWidth + sizing.rightWidth;
  const down = sizing.topHeight + sizing.bottomHeight;
  const spare = { x: art.width - screen.width, y: art.height - screen.height };
  if (
    spare.x <= 0 ||
    spare.y <= 0 ||
    Math.abs(spare.x - across) > compositeSlack ||
    Math.abs(spare.y - down) > compositeSlack
  ) {
    const opening = { width: art.width - across, height: art.height - down };
    if (opening.width <= 0 || opening.height <= 0) return undefined;
    const shape = screen.width / screen.height;
    if (Math.abs(opening.width / opening.height - shape) > shape * shapeSlack) return undefined;
    return {
      body: { width: art.width, height: art.height },
      origin: { x: sizing.leftWidth, y: sizing.topHeight },
      screen: opening,
      image: artUrl(art),
    };
  }
  return {
    body: { width: art.width, height: art.height },
    origin: {
      x: across > 0 ? (spare.x * sizing.leftWidth) / across : spare.x / 2,
      y: down > 0 ? (spare.y * sizing.topHeight) / down : spare.y / 2,
    },
    image: artUrl(art),
  };
}

/** The body built from the chrome's nine pieces around the screen. */
async function slicedFrame(
  chrome: SimulatorChromeFile,
  screen: { width: number; height: number },
  read: ArtReader,
  paint: BodyPainter,
): Promise<Frame | undefined> {
  const { sizing } = chrome.images;
  const body = {
    width: screen.width + sizing.leftWidth + sizing.rightWidth,
    height: screen.height + sizing.topHeight + sizing.bottomHeight,
  };
  const [drawn, middle] = await Promise.all([
    Promise.all(
      pieces.map(async (piece, index) => {
        const pieceArt = await readArt(read, "chrome", chrome.images[piece], `p${index}`);
        return pieceArt ? ([piece, pieceArt] as const) : undefined;
      }),
    ),
    chrome.images.screen ? readArt(read, "chrome", chrome.images.screen, "c") : undefined,
  ]);
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
  const parts = { topLeft, top, topRight, right, bottomRight, bottom, bottomLeft, left, middle };
  const image = await paint(body, bodyLayout(parts, body.width, body.height));
  if (!image) return undefined;
  return { body, origin: { x: sizing.leftWidth, y: sizing.topHeight }, image };
}

/**
 * A Simulator's look around one of its screens, or undefined when its chrome can't be drawn (a
 * piece missing or unreadable). The screen mask and notch are added when the screen has them.
 */
export async function simulatorChrome(
  panel: SimulatorPanel,
  chrome: SimulatorChromeFile,
  read: ArtReader,
  /** How a body built from pieces is painted; SVG unless the caller can paint better. */
  paint: BodyPainter = svgBody,
): Promise<DeviceChrome | undefined> {
  const screen = { width: panel.width, height: panel.height };
  const frame =
    (await compositeFrame(chrome, screen, read)) ??
    (await slicedFrame(chrome, screen, read, paint));
  if (!frame) return undefined;
  const { body, origin } = frame;
  // Body units per point of the screen: 1, unless the body was drawn for a bigger or smaller one.
  const shown = frame.screen ?? screen;
  const unit = shown.width / screen.width;
  const [mask, sensorBar, buttons] = await Promise.all([
    panel.framebufferMask ? readArt(read, "profile", panel.framebufferMask, "m") : undefined,
    panel.sensorBarImage ? readArt(read, "profile", panel.sensorBarImage, "s") : undefined,
    Promise.all(
      chrome.inputs.map(async (input): Promise<DeviceChromeButton | undefined> => {
        const [image, pressed] = await Promise.all([
          readArt(read, "chrome", input.image, "b"),
          input.imageDown ? readArt(read, "chrome", input.imageDown, "d") : undefined,
        ]);
        if (!image) return undefined;
        const art = alongEdge(image, input);
        return {
          name: input.name,
          ...(input.accessibilityTitle ? { title: input.accessibilityTitle } : {}),
          rect: buttonRect(input, art, body),
          image: artUrl(art),
          ...(pressed ? { pressed: artUrl(alongEdge(pressed, input)) } : {}),
          onTop: input.onTop ?? false,
        };
      }),
    ),
  ]);
  return {
    body: { ...body, image: frame.image },
    screen: { ...origin, ...shown },
    ...(mask ? { mask: artUrl(mask) } : {}),
    ...(sensorBar
      ? {
          cutout: {
            rect: {
              x: origin.x + (shown.width - sensorBar.width * unit) / 2,
              y: origin.y,
              width: sensorBar.width * unit,
              height: sensorBar.height * unit,
            },
            image: artUrl(sensorBar),
          },
        }
      : {}),
    buttons: buttons.filter((button) => button !== undefined).slice(0, 8),
  };
}
