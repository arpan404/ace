import type { DeviceChromeRect } from "@ace/protocol/devices";
import type { SvgArt } from "./pdf-svg.ts";

/*
 * A Simulator body built from its chrome's nine pieces: where each piece goes, and how the
 * placed pieces become one picture. Pure: the default painter writes SVG; the daemon passes one
 * that paints PNG.
 */

export type BodyPiece =
  | "topLeft"
  | "top"
  | "topRight"
  | "right"
  | "bottomRight"
  | "bottom"
  | "bottomLeft"
  | "left";

/** One piece of art stretched over `rect` of the body (edges stretch, corners don't). */
export interface PlacedPiece {
  art: SvgArt;
  rect: DeviceChromeRect;
}

/** Paints the placed pieces, in order, as one image of `size` body units; a data URL. */
export type BodyPainter = (
  size: { width: number; height: number },
  pieces: readonly PlacedPiece[],
) => Promise<string | undefined>;

const round = (value: number) => Math.round(value * 1000) / 1000;
const atLeast = (value: number) => Math.max(0.001, value);

/**
 * Where the nine pieces go around a body of `width` × `height`, in drawing order: the fill
 * behind the screen, the edges stretched between the corners (tucked one unit under them),
 * then the corners at their own size, as Simulator lays them out.
 */
export function bodyLayout(
  art: Record<BodyPiece, SvgArt> & { middle?: SvgArt | undefined },
  width: number,
  height: number,
): PlacedPiece[] {
  const { topLeft, top, topRight, right, bottomRight, bottom, bottomLeft, left, middle } = art;
  return [
    ...(middle
      ? [
          {
            art: middle,
            rect: {
              x: left.width,
              y: top.height,
              width: atLeast(width - left.width - right.width),
              height: atLeast(height - top.height - bottom.height),
            },
          },
        ]
      : []),
    {
      art: top,
      rect: {
        x: topLeft.width - 1,
        y: 0,
        width: atLeast(width - topLeft.width - topRight.width + 2),
        height: top.height,
      },
    },
    {
      art: bottom,
      rect: {
        x: bottomLeft.width - 1,
        y: height - bottom.height,
        width: atLeast(width - bottomLeft.width - bottomRight.width + 2),
        height: bottom.height,
      },
    },
    {
      art: left,
      rect: {
        x: 0,
        y: topLeft.height - 1,
        width: left.width,
        height: atLeast(height - topLeft.height - bottomLeft.height + 2),
      },
    },
    {
      art: right,
      rect: {
        x: width - right.width,
        y: topRight.height - 1,
        width: right.width,
        height: atLeast(height - topRight.height - bottomRight.height + 2),
      },
    },
    { art: topLeft, rect: { x: 0, y: 0, width: topLeft.width, height: topLeft.height } },
    {
      art: topRight,
      rect: { x: width - topRight.width, y: 0, width: topRight.width, height: topRight.height },
    },
    {
      art: bottomLeft,
      rect: {
        x: 0,
        y: height - bottomLeft.height,
        width: bottomLeft.width,
        height: bottomLeft.height,
      },
    },
    {
      art: bottomRight,
      rect: {
        x: width - bottomRight.width,
        y: height - bottomRight.height,
        width: bottomRight.width,
        height: bottomRight.height,
      },
    },
  ];
}

/** One piece's art stretched over `width` × `height`, as its own SVG element. */
export function stretchedArt(art: SvgArt, width: number, height: number): string {
  return `<svg width="${round(width)}" height="${round(height)}" viewBox="0 0 ${round(art.width)} ${round(art.height)}" preserveAspectRatio="none" overflow="hidden">${art.svg}</svg>`;
}

/**
 * The pieces as one SVG. Where two pieces meet off a pixel boundary, a browser's smoothing
 * can show a hairline of the grey under each piece's glass; the daemon paints PNG instead.
 */
export const svgBody: BodyPainter = async (size, pieces) => {
  const parts = pieces.map(
    ({ art, rect }) =>
      `<svg x="${round(rect.x)}" y="${round(rect.y)}"${stretchedArt(art, rect.width, rect.height).slice("<svg".length)}`,
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(size.width)} ${round(size.height)}" width="${round(size.width)}" height="${round(size.height)}">${parts.join("")}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
};
