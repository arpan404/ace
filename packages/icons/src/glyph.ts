import {
  createElement,
  useId,
  type FunctionComponent,
  type ReactNode,
  type RefAttributes,
  type SVGProps,
} from "react";
import type { Outline, Part } from "./parts.ts";

/** The weights callers ask for. `thin` and `light` draw as `regular`. */
export type IconWeight = "thin" | "light" | "regular" | "bold" | "fill" | "duotone";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "ref" | "color"> {
  size?: number | string;
  weight?: IconWeight;
  color?: string;
  /** Flipped left to right, for right-to-left layouts. */
  mirrored?: boolean;
  /** A title for assistive tech. */
  alt?: string;
}

/** An icon component. Like any React 19 component it takes `ref` as a prop; it lands on the `<svg>`. */
export type Icon = FunctionComponent<IconProps & RefAttributes<SVGSVGElement>>;

/** How a weight paints: strokes only, strokes over a tint, or a solid body with details cut out. */
type Look = "outline" | "tint" | "solid";

const strokeOf = (weight: IconWeight): number => (weight === "bold" ? 2.25 : 1.75);
const lookOf = (weight: IconWeight): Look =>
  weight === "fill" ? "solid" : weight === "duotone" ? "tint" : "outline";

/** The eight dashes of a dashed ring, with gaps that stay open at any stroke. */
function dashes(r: number, stroke: number): SVGProps<SVGCircleElement> {
  const around = 2 * Math.PI * r;
  const gap = 2.4 + stroke;
  const turn = -90 - 22.5 + (gap / around) * 180;
  return { strokeDasharray: `${around / 8 - gap} ${gap}`, transform: `rotate(${turn} 12 12)` };
}

type Paint = "stroke" | "tint" | "fill" | "cut" | "spot" | "cutSpot";

function paintProps(paint: Paint, stroke: number, ink: string): SVGProps<SVGElement> {
  const strokeProps = {
    strokeWidth: stroke,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  switch (paint) {
    case "stroke":
      return { fill: "none", stroke: ink, ...strokeProps };
    case "tint":
      return { fill: ink, fillOpacity: 0.2, stroke: ink, ...strokeProps };
    case "fill":
      return { fill: ink, stroke: ink, ...strokeProps };
    case "cut":
      return { fill: "none", stroke: "black", ...strokeProps };
    case "spot":
      return { fill: ink };
    case "cutSpot":
      return { fill: "black" };
  }
}

function element(outline: Outline, props: SVGProps<SVGElement>, key: string): ReactNode {
  return typeof outline === "string"
    ? createElement("path", { key, d: outline, ...props })
    : createElement("circle", { key, cx: outline.cx, cy: outline.cy, r: outline.r, ...props });
}

/** A mask that shows everything but `cuts`. */
function mask(id: string, cuts: ReactNode[]): ReactNode {
  return createElement(
    "mask",
    { key: id, id, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: 24, height: 24 },
    createElement("rect", { width: 24, height: 24, fill: "white" }),
    ...cuts,
  );
}

/** Every element of a glyph in one weight; `id` keeps this instance's masks its own. */
function draw(parts: readonly Part[], weight: IconWeight, ink: string, id: string): ReactNode[] {
  const stroke = strokeOf(weight);
  const look = lookOf(weight);
  const defs: ReactNode[] = [];
  const paintOne = (part: Part, paint: Paint, key: string): ReactNode => {
    const extra =
      part.dashed && typeof part.outline !== "string" ? dashes(part.outline.r, stroke) : {};
    const drawn = element(part.outline, { ...paintProps(paint, stroke, ink), ...extra }, key);
    if (!part.hole || paint === "cut" || paint === "cutSpot") return drawn;
    const holeId = `${id}-h${key}`;
    defs.push(
      mask(holeId, [
        createElement("circle", {
          key: "h",
          cx: part.hole.cx,
          cy: part.hole.cy,
          r: part.hole.r,
          fill: "black",
        }),
      ]),
    );
    return createElement("g", { key, mask: `url(#${holeId})` }, drawn);
  };

  if (look !== "solid") {
    const drawn = parts.map((part, i) =>
      paintOne(
        part,
        part.role === "spot"
          ? "spot"
          : look === "tint" && part.role === "shape"
            ? "tint"
            : "stroke",
        `${i}`,
      ),
    );
    return defs.length ? [createElement("defs", { key: "defs" }, ...defs), ...drawn] : drawn;
  }

  const bodies: ReactNode[] = [];
  const cuts: ReactNode[] = [];
  const over: ReactNode[] = [];
  parts.forEach((part, i) => {
    const key = `${i}`;
    if (part.role === "shape") bodies.push(paintOne(part, "fill", key));
    else if (part.role === "detail") cuts.push(paintOne(part, "cut", key));
    else if (part.role === "spot") cuts.push(paintOne(part, "cutSpot", key));
    else over.push(paintOne(part, "stroke", key));
  });
  const cutId = `${id}-cut`;
  if (cuts.length) defs.push(mask(cutId, cuts));
  const body = cuts.length
    ? createElement("g", { key: "body", mask: `url(#${cutId})` }, ...bodies)
    : bodies;
  return [
    ...(defs.length ? [createElement("defs", { key: "defs" }, ...defs)] : []),
    ...(Array.isArray(body) ? body : [body]),
    ...over,
  ];
}

/**
 * An icon from its parts. The parts are built once, the first time the icon draws; every weight
 * comes from the same parts. Props follow the common icon-component shape (size, weight, color,
 * mirrored), and the rest, `ref` included, go to the `<svg>`.
 */
export function glyph(name: string, build: () => readonly Part[]): Icon {
  let parts: readonly Part[] | undefined;
  const Glyph: Icon = function Glyph(props) {
    const {
      size = "1em",
      weight = "regular",
      color = "currentColor",
      mirrored,
      alt,
      style,
      children,
      ...svg
    } = props;
    const id = useId();
    parts ??= build();
    return createElement(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        style: mirrored ? { ...style, transform: "scaleX(-1)" } : style,
        ...svg,
      },
      alt ? createElement("title", { key: "title" }, alt) : null,
      ...draw(parts, weight, color, id),
      children,
    );
  };
  Glyph.displayName = name;
  return Glyph;
}
