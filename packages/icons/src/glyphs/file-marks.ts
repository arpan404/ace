/**
 * The marks that tell file types apart, each drawn inside the page from `file.ts`, one per kind
 * of file: code, markup, style, table, database, document, text, markdown, image, vector, audio,
 * video, archive, PDF, slides, lock and config. Marks, not letters: letters blur at 16 px.
 */
import { circle, detail, spot, type Part } from "../parts.ts";
import { onCircle, polygon, polyline, rect, type Vertex } from "../geometry.ts";
import { page } from "./file.ts";

/** The page with `marks` inside it. */
export const fileWith = (marks: readonly Part[]): Part[] => [...page(), ...marks];

/** Source code: a pair of angle brackets. */
export const codeMark = (): Part[] => [
  detail(
    polyline([
      [10, 11.75],
      [7.75, 14.75, 0.7],
      [10, 17.75],
    ]),
  ),
  detail(
    polyline([
      [14, 11.75],
      [16.25, 14.75, 0.7],
      [14, 17.75],
    ]),
  ),
];

/** Markup and components: a closing tag, brackets around a slash. */
export const markupMark = (): Part[] => [
  detail(
    polyline([
      [9.5, 12],
      [7.5, 14.75, 0.7],
      [9.5, 17.5],
    ]),
  ),
  detail(
    polyline([
      [14.5, 12],
      [16.5, 14.75, 0.7],
      [14.5, 17.5],
    ]),
  ),
  detail("M12.9 11.75 11.1 17.75"),
];

/** One curly brace, opening (`side` -1) or closing (1). */
const brace = (side: 1 | -1): Part => {
  const x = (dx: number) => 12 + side * dx;
  return detail(
    polyline([
      [x(1.5), 11.5],
      [x(2.6), 11.5, 1],
      [x(2.6), 13.9, 1],
      [x(3.9), 14.75],
      [x(2.6), 15.6, 1],
      [x(2.6), 18, 1],
      [x(1.5), 18],
    ]),
  );
};

/** Styles: a pair of curly braces. */
export const styleMark = (): Part[] => [brace(-1), brace(1)];

/** Tables and spreadsheets: a grid of four cells. */
export const tableMark = (): Part[] => [
  detail(rect(8, 11.25, 8, 7, 1.5)),
  detail("M8.4 14.75h7.2M12 11.65v6.2"),
];

/** A database: a short cylinder. */
export const databaseMark = (): Part[] => [
  detail("M8.5 12.25a3.5 1.4 0 1 0 7 0a3.5 1.4 0 1 0-7 0"),
  detail("M8.5 12.25v4.75a3.5 1.4 0 0 0 7 0v-4.75"),
];

/** A document: a paragraph mark. */
export const documentMark = (): Part[] => [
  spot("M12.4 11.25v4.5h-0.9a2.25 2.25 0 0 1 0-4.5Z"),
  detail("M12.4 11.25h3.1M12.4 11.25v6.75M15 11.25v6.75"),
];

/** Plain text: three left-aligned lines. */
export const textMark = (): Part[] => [detail("M8.5 12h7M8.5 15h7M8.5 18h4")];

/** Markdown: a heading's hash. */
export const markdownMark = (): Part[] => [
  detail("M10.9 11.5 10.1 18M14.4 11.5 13.6 18M8.4 13.4h7.6M8 16.1h7.6"),
];

/** An image: a hill under a sun. */
export const imageMark = (): Part[] => [
  dotAt(9.75, 12.25, 1.4),
  detail(
    polyline([
      [8, 18.25],
      [12.5, 13.75, 0.9],
      [16, 17.25],
    ]),
  ),
];

/** Vector art: a curve between two of its points. */
export const vectorMark = (): Part[] => [
  detail("M9.25 17C9.25 14 11.5 12 14.75 12"),
  dotAt(9.25, 17.5, 1.5),
  dotAt(15.25, 12, 1.5),
];

/** Audio: a music note. */
export const audioMark = (): Part[] => [
  dotAt(11.4, 17.25, 1.65),
  detail(
    polyline([
      [12.9, 17.25],
      [12.9, 11.25, 0.6],
      [15.75, 12.6],
    ]),
  ),
];

/** Video: a play button. */
export const videoMark = (): Part[] => [
  detail(
    polygon([
      [10, 11.75, 1],
      [15.5, 14.75, 1],
      [10, 17.75, 1],
    ]),
  ),
];

/** An archive: a zipper down the page, with its pull. */
export const archiveMark = (): Part[] => [
  detail("M9.5 5.5h1.25M10.75 7.75H12M9.5 10h1.25"),
  spot(rect(9.25, 12.75, 3, 5.25, 1.5)),
];

/** A PDF: a fixed layout, a picture over two lines. */
export const layoutMark = (): Part[] => [detail(rect(8, 11, 8, 4, 1)), detail("M8 18h8")];

/** Slides: a bar chart. */
export const slidesMark = (): Part[] => [detail("M8.75 18v-3M12 18v-6M15.25 18v-4")];

/** A lockfile: a padlock. */
export const lockMark = (): Part[] => [
  detail(rect(8.5, 14, 7, 4.75, 1.5)),
  detail("M10.1 14v-1.6a1.9 1.9 0 0 1 3.8 0V14"),
];

/** Settings: two sliders. */
export const configMark = (): Part[] => [
  detail(circle(9.75, 12.5, 1.5)),
  detail("M11.25 12.5H16"),
  detail(circle(14.25, 17, 1.5)),
  detail("M8 17h4.75"),
];

function dotAt(cx: number, cy: number, r: number): Part {
  return spot(circle(cx, cy, r));
}

/** A five-pointed star, `r` from centre to tip, as vertices. */
export function starPoints(cx: number, cy: number, r: number): Vertex[] {
  const points: Vertex[] = [];
  for (let i = 0; i < 10; i++) {
    const outer = i % 2 === 0;
    const [x, y] = onCircle(cx, cy, outer ? r : r * 0.48, -90 + i * 36);
    points.push([x, y, outer ? 0.6 : 0.3]);
  }
  return points;
}
