import {
  firstPage,
  isDict,
  isKeyword,
  nameOf,
  numbersOf,
  PdfLexer,
  resolve,
  streamText,
  type PdfDict,
  type PdfValue,
} from "./pdf-objects.ts";

/*
 * A PDF page's vector drawing as SVG: paths, solid fills and strokes, transparency, clips and
 * nested forms. That is all Apple's device artwork uses; images, shadings and text are left
 * out. Pure: the bytes of the PDF in, SVG text out.
 */

/** A page drawn as SVG: its size in PDF units and the markup. */
export interface SvgArt {
  width: number;
  height: number;
  svg: string;
}

type Matrix = [number, number, number, number, number, number];
interface State {
  ctm: Matrix;
  fill: string;
  stroke: string;
  fillAlpha: number;
  strokeAlpha: number;
  fillComponents: number;
  strokeComponents: number;
  lineWidth: number;
  cap: number;
  join: number;
  miter: number;
  dash: string | undefined;
  /** `<g>` elements opened since this state was saved, closed again by `Q`. */
  opened: number;
}

const identity: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];
const round = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};
const channel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);
function color(components: readonly number[]): string {
  const [a = 0, b = 0, c = 0, d = 0] = components;
  const rgb =
    components.length >= 4
      ? [(1 - a) * (1 - d), (1 - b) * (1 - d), (1 - c) * (1 - d)]
      : components.length === 3
        ? [a, b, c]
        : [a, a, a];
  return `rgb(${rgb.map(channel).join(",")})`;
}
const point = (x: number, y: number) => `${round(x)} ${round(y)}`;
/** A copy of the graphics state for a new `q` level, with no groups of its own open yet. */
const saved = (state: State): State => ({ ...state, opened: 0 });
const caps = ["butt", "round", "square"];
const joins = ["miter", "round", "bevel"];

/** Interprets one page's drawing (and the forms it draws) into SVG elements. */
class Painter {
  readonly out: string[] = [];
  readonly defs: string[] = [];
  painted = 0;
  private clips = 0;
  private readonly prefix: string;
  private readonly objects: Map<number, PdfValue>;
  private depth = 0;
  constructor(objects: Map<number, PdfValue>, prefix: string) {
    this.objects = objects;
    this.prefix = prefix;
  }
  run(content: string, resources: PdfDict | undefined, start: State): void {
    const stack: State[] = [];
    let state = saved(start);
    let path: string[] = [];
    let current: [number, number] = [0, 0];
    let subpath: [number, number] = [0, 0];
    let clip: "nonzero" | "evenodd" | undefined;
    let operands: PdfValue[] = [];
    const lexer = new PdfLexer(content);
    const resource = (group: string, name: string | undefined) => {
      const dict = resolve(this.objects, resources?.entries.get(group));
      return name && isDict(dict) ? resolve(this.objects, dict.entries.get(name)) : undefined;
    };
    const num = (index: number) => {
      const value = operands[operands.length - 1 - index];
      return typeof value === "number" ? value : 0;
    };
    const paint = (fill: "nonzero" | "evenodd" | undefined, stroke: boolean) => {
      if (path.length && (fill || stroke)) {
        const attributes = [
          `d="${path.join("")}"`,
          `transform="matrix(${state.ctm.map(round).join(" ")})"`,
        ];
        attributes.push(fill ? `fill="${state.fill}"` : `fill="none"`);
        if (fill === "evenodd") attributes.push(`fill-rule="evenodd"`);
        if (fill && state.fillAlpha < 1)
          attributes.push(`fill-opacity="${round(state.fillAlpha)}"`);
        if (stroke) {
          attributes.push(
            `stroke="${state.stroke}"`,
            `stroke-width="${round(state.lineWidth || 1)}"`,
            `stroke-linecap="${caps[state.cap] ?? "butt"}"`,
            `stroke-linejoin="${joins[state.join] ?? "miter"}"`,
            `stroke-miterlimit="${round(Math.max(1, state.miter))}"`,
          );
          if (state.dash) attributes.push(`stroke-dasharray="${state.dash}"`);
          if (state.strokeAlpha < 1)
            attributes.push(`stroke-opacity="${round(state.strokeAlpha)}"`);
        }
        this.out.push(`<path ${attributes.join(" ")}/>`);
        this.painted++;
      }
      if (clip && path.length) {
        const id = `${this.prefix}c${this.clips++}`;
        this.defs.push(
          `<clipPath id="${id}"><path d="${path.join("")}" transform="matrix(${state.ctm.map(round).join(" ")})" clip-rule="${clip}"/></clipPath>`,
        );
        this.out.push(`<g clip-path="url(#${id})">`);
        state.opened++;
      }
      path = [];
      clip = undefined;
    };
    for (;;) {
      const token = lexer.next();
      if (token === undefined) break;
      if (!isKeyword(token)) {
        operands.push(token);
        if (operands.length > 64) operands = operands.slice(-64);
        continue;
      }
      switch (token.keyword) {
        case "q":
          stack.push(state);
          state = saved(state);
          break;
        case "Q":
          this.out.push("</g>".repeat(state.opened));
          state = stack.pop() ?? state;
          break;
        case "cm":
          state.ctm = multiply([num(5), num(4), num(3), num(2), num(1), num(0)], state.ctm);
          break;
        case "m":
          path.push(`M${point(num(1), num(0))}`);
          current = subpath = [num(1), num(0)];
          break;
        case "l":
          path.push(`L${point(num(1), num(0))}`);
          current = [num(1), num(0)];
          break;
        case "c":
          path.push(`C${point(num(5), num(4))} ${point(num(3), num(2))} ${point(num(1), num(0))}`);
          current = [num(1), num(0)];
          break;
        case "v":
          path.push(`C${point(...current)} ${point(num(3), num(2))} ${point(num(1), num(0))}`);
          current = [num(1), num(0)];
          break;
        case "y":
          path.push(`C${point(num(3), num(2))} ${point(num(1), num(0))} ${point(num(1), num(0))}`);
          current = [num(1), num(0)];
          break;
        case "h":
          path.push("Z");
          current = subpath;
          break;
        case "re": {
          const [x, y, w, h] = [num(3), num(2), num(1), num(0)];
          path.push(`M${point(x, y)}h${round(w)}v${round(h)}h${round(-w)}Z`);
          current = subpath = [x, y];
          break;
        }
        case "W":
          clip = "nonzero";
          break;
        case "W*":
          clip = "evenodd";
          break;
        case "n":
          paint(undefined, false);
          break;
        case "f":
        case "F":
          paint("nonzero", false);
          break;
        case "f*":
          paint("evenodd", false);
          break;
        case "S":
          paint(undefined, true);
          break;
        case "s":
          path.push("Z");
          paint(undefined, true);
          break;
        case "B":
          paint("nonzero", true);
          break;
        case "B*":
          paint("evenodd", true);
          break;
        case "b":
          path.push("Z");
          paint("nonzero", true);
          break;
        case "b*":
          path.push("Z");
          paint("evenodd", true);
          break;
        case "w":
          state.lineWidth = num(0);
          break;
        case "J":
          state.cap = num(0);
          break;
        case "j":
          state.join = num(0);
          break;
        case "M":
          state.miter = num(0);
          break;
        case "d": {
          const dashes = numbersOf(operands[operands.length - 2]);
          state.dash = dashes.length ? dashes.map(round).join(" ") : undefined;
          break;
        }
        case "cs":
        case "CS": {
          const name = nameOf(operands[operands.length - 1]);
          const space = resolve(this.objects, resource("ColorSpace", name));
          const icc = Array.isArray(space) ? resolve(this.objects, space[1]) : undefined;
          const components =
            name === "DeviceGray" || name === "CalGray"
              ? 1
              : name === "DeviceCMYK"
                ? 4
                : isDict(icc) && typeof icc.entries.get("N") === "number"
                  ? Number(icc.entries.get("N"))
                  : 3;
          const initial = color(components === 4 ? [0, 0, 0, 1] : [0]);
          if (token.keyword === "cs")
            Object.assign(state, { fillComponents: components, fill: initial });
          else Object.assign(state, { strokeComponents: components, stroke: initial });
          break;
        }
        case "sc":
        case "scn": {
          const values = operands.filter((value): value is number => typeof value === "number");
          if (values.length) state.fill = color(values.slice(-state.fillComponents));
          break;
        }
        case "SC":
        case "SCN": {
          const values = operands.filter((value): value is number => typeof value === "number");
          if (values.length) state.stroke = color(values.slice(-state.strokeComponents));
          break;
        }
        case "g":
          Object.assign(state, { fill: color([num(0)]), fillComponents: 1 });
          break;
        case "G":
          Object.assign(state, { stroke: color([num(0)]), strokeComponents: 1 });
          break;
        case "rg":
          Object.assign(state, { fill: color([num(2), num(1), num(0)]), fillComponents: 3 });
          break;
        case "RG":
          Object.assign(state, { stroke: color([num(2), num(1), num(0)]), strokeComponents: 3 });
          break;
        case "k":
          Object.assign(state, {
            fill: color([num(3), num(2), num(1), num(0)]),
            fillComponents: 4,
          });
          break;
        case "K":
          Object.assign(state, {
            stroke: color([num(3), num(2), num(1), num(0)]),
            strokeComponents: 4,
          });
          break;
        case "gs": {
          const graphics = resource("ExtGState", nameOf(operands[operands.length - 1]));
          if (isDict(graphics)) {
            const entry = (key: string) => graphics.entries.get(key);
            if (typeof entry("ca") === "number") state.fillAlpha = Number(entry("ca"));
            if (typeof entry("CA") === "number") state.strokeAlpha = Number(entry("CA"));
            if (typeof entry("LW") === "number") state.lineWidth = Number(entry("LW"));
          }
          break;
        }
        case "Do": {
          const form = resource("XObject", nameOf(operands[operands.length - 1]));
          if (!isDict(form) || nameOf(form.entries.get("Subtype")) !== "Form" || this.depth > 8)
            break;
          const matrix = numbersOf(form.entries.get("Matrix"));
          const own = resolve(this.objects, form.entries.get("Resources"));
          this.depth++;
          this.run(streamText(form), isDict(own) ? own : resources, {
            ...state,
            ctm: matrix.length === 6 ? multiply(matrix as Matrix, state.ctm) : state.ctm,
          });
          this.depth--;
          break;
        }
        case "BT":
          // Text never appears in device art; skip to its end.
          for (let next = lexer.next(); next !== undefined; next = lexer.next())
            if (isKeyword(next) && next.keyword === "ET") break;
          break;
        case "BI":
          for (let next = lexer.next(); next !== undefined; next = lexer.next())
            if (isKeyword(next) && next.keyword === "EI") break;
          break;
        default:
          break;
      }
      operands = [];
    }
    this.out.push("</g>".repeat(state.opened));
    while (stack.length) this.out.push("</g>".repeat(stack.pop()?.opened ?? 0));
  }
}

const initial: State = {
  ctm: identity,
  fill: "rgb(0,0,0)",
  stroke: "rgb(0,0,0)",
  fillAlpha: 1,
  strokeAlpha: 1,
  fillComponents: 1,
  strokeComponents: 1,
  lineWidth: 1,
  cap: 0,
  join: 0,
  miter: 10,
  dash: undefined,
  opened: 0,
};

/**
 * A PDF's first page as SVG elements in a viewBox of its own size (y pointing down), or
 * undefined when it draws nothing ace can show. `prefix` keeps clip ids unique when several
 * drawings share one document.
 */
export function pdfArt(bytes: Uint8Array, prefix = "a"): SvgArt | undefined {
  const page = firstPage(bytes);
  if (!page) return undefined;
  const painter = new Painter(page.objects, prefix);
  painter.run(page.content, page.resources, initial);
  if (painter.painted === 0) return undefined;
  const [x0, y0, x1, y1] = page.box;
  const width = x1 - x0;
  const height = y1 - y0;
  const defs = painter.defs.length ? `<defs>${painter.defs.join("")}</defs>` : "";
  const body = `<g transform="matrix(1 0 0 -1 ${round(-x0)} ${round(y1)})">${painter.out.join("")}</g>`;
  return { width, height, svg: `${defs}${body}` };
}

/** Art as a standalone SVG document, drawn at its own size. */
export function svgDocument(art: SvgArt): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(art.width)} ${round(art.height)}" width="${round(art.width)}" height="${round(art.height)}">${art.svg}</svg>`;
}
