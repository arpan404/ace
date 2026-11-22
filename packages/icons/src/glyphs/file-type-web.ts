/**
 * File types of the web's languages and data: TypeScript, JavaScript, their components, JSON,
 * HTML, CSS, SVG and XML. Each is its own outline, not a page with a letter: TypeScript is a
 * square tile, JavaScript a round one, components carry a closing tag. ace's own drawings
 * (ADR 0156); the app paints each in its type's tone.
 */
import { glyph } from "../glyph.ts";
import { polyline, rect } from "../geometry.ts";
import { circle, detail, line, shape, spot, type Part } from "../parts.ts";

const tile = (): Part => shape(rect(3, 3, 18, 18, 5));
const disc = (): Part => shape(circle(12, 12, 9));

/** A closing tag, brackets around a slash, centred on the box. */
const tag = (): Part[] => [
  detail(
    polyline([
      [9.25, 9],
      [7, 12, 0.7],
      [9.25, 15],
    ]),
  ),
  detail(
    polyline([
      [14.75, 9],
      [17, 12, 0.7],
      [14.75, 15],
    ]),
  ),
  detail("M12.9 8.75 11.1 15.25"),
];

/** TypeScript: a square tile with a type's crossbar. */
export const TypescriptFileIcon = /* @__PURE__ */ glyph("TypescriptFile", () => [
  tile(),
  detail("M7.75 8.75h8.5M12 8.75v7.5"),
]);

/** TypeScript components: the square tile holding a closing tag. */
export const TsxFileIcon = /* @__PURE__ */ glyph("TsxFile", () => [tile(), ...tag()]);

/** JavaScript: a round tile with a hook. */
export const JavascriptFileIcon = /* @__PURE__ */ glyph("JavascriptFile", () => [
  disc(),
  detail("M13.75 7.75v5.5a3 3 0 0 1-6 0"),
  spot(circle(16.25, 15.5, 1.3)),
]);

/** JavaScript components: the round tile holding a closing tag. */
export const JsxFileIcon = /* @__PURE__ */ glyph("JsxFile", () => [disc(), ...tag()]);

/** One tall curly brace, opening (`side` -1) or closing (1). */
const brace = (side: 1 | -1): Part => {
  const x = (dx: number) => 12 + side * dx;
  return line(
    polyline([
      [x(4), 3.5],
      [x(6), 3.5, 1.8],
      [x(6), 10, 1.6],
      [x(8.5), 12],
      [x(6), 14, 1.6],
      [x(6), 20.5, 1.8],
      [x(4), 20.5],
    ]),
  );
};

/** JSON: curly braces around a key's colon. */
export const JsonFileIcon = /* @__PURE__ */ glyph("JsonFile", () => [
  brace(-1),
  brace(1),
  spot(circle(12, 9, 1.5)),
  spot(circle(12, 15, 1.5)),
]);

/** One tall angle bracket, opening (`side` -1) or closing (1). */
const bracket = (side: 1 | -1): Part =>
  line(
    polyline([
      [12 + side * 4.5, 5],
      [12 + side * 9.25, 12, 1],
      [12 + side * 4.5, 19],
    ]),
  );

/** HTML: angle brackets around an element. */
export const HtmlFileIcon = /* @__PURE__ */ glyph("HtmlFile", () => [
  bracket(-1),
  bracket(1),
  spot(circle(12, 12, 1.9)),
]);

/** XML: angle brackets around a slash. */
export const XmlFileIcon = /* @__PURE__ */ glyph("XmlFile", () => [
  bracket(-1),
  bracket(1),
  line("M13.6 5.5 10.4 18.5"),
]);

/** Styles: a drop of paint. */
export const CssFileIcon = /* @__PURE__ */ glyph("CssFile", () => [
  shape(
    "M12 2.75C9.25 6.5 5.25 10.75 5.25 14.5a6.75 6.75 0 0 0 13.5 0C18.75 10.75 14.75 6.5 12 2.75Z",
  ),
  detail("M8.75 14.75a3.25 3.25 0 0 0 3.25 3.25"),
]);

/** Vector art: a curve between two square anchor points, one with its handle. */
export const SvgFileIcon = /* @__PURE__ */ glyph("SvgFile", () => [
  line("M5.75 16.5C5.75 10.5 10 7 17 6.25"),
  line("M17.5 6.25h3.25"),
  shape(rect(3.5, 16.25, 4.5, 4.5, 1.25)),
  shape(rect(13.75, 3.75, 4.5, 4.5, 1.25)),
]);
