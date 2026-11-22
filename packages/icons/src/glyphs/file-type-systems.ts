/**
 * File types of compiled and scripting languages. Marks, not logos: Rust is a hex nut, Go a disc
 * in motion, Swift a bird in flight, Kotlin a diamond, Java a cup, the C family an open ring
 * (with a plus pair for C++ and a hash for C#), Ruby a gem, PHP an oval, Lua a crescent, Zig a
 * zigzag, Python a coiled snake, Shell a terminal. ace's own drawings (ADR 0156).
 */
import { glyph } from "../glyph.ts";
import { arc, ellipse, onCircle, polygon, polyline } from "../geometry.ts";
import { circle, detail, line, shape, spot, type Part } from "../parts.ts";
import { terminalWindow } from "./terminal-window.ts";

/** Rust: a hex nut, its bore showing. */
export const RustFileIcon = /* @__PURE__ */ glyph("RustFile", () => [
  shape(polygon([0, 60, 120, 180, 240, 300].map((a) => [...onCircle(12, 12, 9.5, a + 30), 2]))),
  detail(circle(12, 12, 3.25)),
]);

/** Go: a disc with speed lines trailing behind it. */
export const GoFileIcon = /* @__PURE__ */ glyph("GoFile", () => [
  shape(circle(14.25, 12, 7)),
  spot(circle(16.25, 10.25, 1.4)),
  line("M2.75 8.75h3.5M2 12h3.25M2.75 15.25h3.5"),
]);

/** Swift: a bird in flight, seen head on, its wings swept up. */
export const SwiftFileIcon = /* @__PURE__ */ glyph("SwiftFile", () => [
  shape(
    "M2.5 8.5C6 8 9.5 10 12 14.25C14.5 10 18 8 21.5 8.5C18.25 10.25 15.25 13.5 13.4 17.6a1.5 1.5 0 0 1-2.8 0C8.75 13.5 5.75 10.25 2.5 8.5Z",
  ),
]);

/** Kotlin: a diamond with a chevron. */
export const KotlinFileIcon = /* @__PURE__ */ glyph("KotlinFile", () => [
  shape(
    polygon([
      [12, 2.5, 2.5],
      [21.5, 12, 2.5],
      [12, 21.5, 2.5],
      [2.5, 12, 2.5],
    ]),
  ),
  detail(
    polyline([
      [14.5, 8.5],
      [11, 12, 0.6],
      [14.5, 15.5],
    ]),
  ),
]);

/** Java: a steaming cup on its saucer. */
export const JavaFileIcon = /* @__PURE__ */ glyph("JavaFile", () => [
  shape(
    polygon([
      [4, 10, 1],
      [17, 10, 1],
      [16.25, 17.25, 3],
      [4.75, 17.25, 3],
    ]),
  ),
  line("M16.9 11.5h1.1a2.5 2.5 0 0 1 0 5h-1.6"),
  line("M3 20.5h15.5"),
  line("M8.25 2.75c-1.1 1.4 1.1 2.6 0 4M12.25 2.75c-1.1 1.4 1.1 2.6 0 4"),
]);

/** The C family's open ring, centred at `cx`. */
const ring = (cx: number, r: number): Part => line(arc(cx, 12, r, 45, 315));

/** C: an open ring. */
export const CFileIcon = /* @__PURE__ */ glyph("CFile", () => [ring(12, 8.25)]);

/** C++: the open ring and a pair of pluses. */
export const CppFileIcon = /* @__PURE__ */ glyph("CppFile", () => [
  ring(9.5, 7),
  line("M18.5 6.75v4.5M16.25 9h4.5M18.5 12.75v4.5M16.25 15h4.5"),
]);

/** C#: the open ring and a hash. */
export const CsharpFileIcon = /* @__PURE__ */ glyph("CsharpFile", () => [
  ring(9.5, 7),
  line("M17.25 7.75l-.75 8.5M20.5 7.75l-.75 8.5M15.75 10.5h5.75M15.25 13.5h5.75"),
]);

/** Ruby: a cut gem. */
export const RubyFileIcon = /* @__PURE__ */ glyph("RubyFile", () => [
  shape(
    polygon([
      [7, 3.75, 1],
      [17, 3.75, 1],
      [21.25, 9.25, 1],
      [12, 20.75, 1.25],
      [2.75, 9.25, 1],
    ]),
  ),
  detail("M3.25 9.25h17.5"),
  detail(
    polyline([
      [8.75, 9.25],
      [12, 19.75],
      [15.25, 9.25],
    ]),
  ),
]);

/** PHP: an oval holding a script's opening angle. */
export const PhpFileIcon = /* @__PURE__ */ glyph("PhpFile", () => [
  shape(ellipse(12, 12, 9.75, 6.75)),
  detail(
    polyline([
      [10.5, 9],
      [7.25, 12, 0.6],
      [10.5, 15],
    ]),
  ),
  spot(circle(14.75, 12, 1.5)),
]);

/** Lua: a crescent moon. */
export const LuaFileIcon = /* @__PURE__ */ glyph("LuaFile", () => {
  // The crescent is the outer disc less an inner one: their crossing points are its horns.
  const [ox, oy, or] = [11.5, 12.5, 8.75];
  const [ix, iy, ir] = [16, 8, 6.75];
  const d = Math.hypot(ix - ox, iy - oy);
  const a = (or * or - ir * ir + d * d) / (2 * d);
  const h = Math.sqrt(or * or - a * a);
  const [mx, my] = [ox + (a * (ix - ox)) / d, oy + (a * (iy - oy)) / d];
  const [px, py] = [(-(iy - oy) * h) / d, ((ix - ox) * h) / d];
  const p1 = `${(mx + px).toFixed(2)} ${(my + py).toFixed(2)}`;
  const p2 = `${(mx - px).toFixed(2)} ${(my - py).toFixed(2)}`;
  return [shape(`M${p1}A${or} ${or} 0 1 1 ${p2}A${ir} ${ir} 0 0 0 ${p1}Z`)];
});

/** Zig: a zigzag. */
export const ZigFileIcon = /* @__PURE__ */ glyph("ZigFile", () => [
  line(
    polyline([
      [3, 6.5],
      [8.25, 17.5, 1.25],
      [12, 8, 1.25],
      [15.75, 17.5, 1.25],
      [21, 6.5],
    ]),
  ),
]);

/** Python: a coiled snake with its eye. */
export const PythonFileIcon = /* @__PURE__ */ glyph("PythonFile", () => [
  line("M15.5 4.25H10a4 4 0 0 0 0 8h4a4 4 0 0 1 0 8H5.5"),
  shape(circle(17.75, 4.75, 2.25)),
  line("M5.5 20.25h-1"),
]);

/** Shell scripts: a terminal and its prompt. */
export const ShellFileIcon = /* @__PURE__ */ glyph("ShellFile", terminalWindow);

/** Fonts: a letter A, the type specimen's mark. */
export const FontFileIcon = /* @__PURE__ */ glyph("FontFile", () => [
  line(
    polyline([
      [4.5, 20.25],
      [12, 3.75, 1.25],
      [19.5, 20.25],
    ]),
  ),
  line("M7.5 14.25h9"),
]);
