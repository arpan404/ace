import { glyph } from "../glyph.ts";
import { onCircle, polygon, polyline, type Point, type Vertex } from "../geometry.ts";
import { circle, detail, line, shape, type Part } from "../parts.ts";

/** A rocket pointing straight up, turned `degrees` clockwise about (cx, cy) and moved there. */
export const rocket = (degrees: number, cx = 12, cy = 12): Part[] => {
  const turn = (v: Vertex): Vertex => {
    const r = Math.hypot(v[0] - 12, v[1] - 12);
    const a = (Math.atan2(v[1] - 12, v[0] - 12) * 180) / Math.PI;
    const [x, y]: Point = onCircle(cx, cy, r, a + degrees);
    return [x, y, v[2]];
  };
  const body: Vertex[] = [
    [12, 2.75, 1.4],
    [15.5, 7.75, 4.5],
    [15.5, 16, 1.2],
    [8.5, 16, 1.2],
    [8.5, 7.75, 4.5],
  ];
  const fin = (side: 1 | -1): Vertex[] => [
    [12 + side * 3.5, 11.5],
    [12 + side * 6.25, 14.25, 1.2],
    [12 + side * 6.25, 17.75, 1],
    [12 + side * 3.5, 16],
  ];
  const [wx, wy] = turn([12, 9.25]);
  return [
    shape(polygon(body.map(turn))),
    line(polyline(fin(-1).map(turn))),
    line(polyline(fin(1).map(turn))),
    detail(circle(wx, wy, 1.7)),
    line(polyline([turn([12, 18.75]), turn([12, 21.25])])),
  ];
};

/** A launch: a rocket pointing up. */
export const RocketIcon = /* @__PURE__ */ glyph("Rocket", () => rocket(0));
