import { describe, expect, it } from "vitest";
import {
  arrange,
  castSizes,
  chooseLayout,
  shotCamera,
  travelled,
  type CastId,
} from "./feature-camera.ts";
import type { Rect } from "./zoom-camera.ts";

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const casts: CastId[][] = [
  ["mac", "phone"],
  ["mac", "build"],
  ["mac", "build", "workstation"],
  ["mac", "workstation", "phone"],
  ["mac", "build", "workstation", "phone"],
];

describe("where a feature page's hardware stands", () => {
  it("no two pieces of hardware overlap, side by side or stacked", () => {
    for (const cast of casts) {
      for (const layout of ["wide", "tall"] as const) {
        const rects = Object.values(arrange(cast, layout)).filter((rect) => rect !== undefined);
        expect(rects).toHaveLength(cast.length);
        rects.forEach((a, i) =>
          rects.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)),
        );
      }
    }
  });

  it("everything rests on the same table as the Mac when side by side", () => {
    const places = arrange(["mac", "phone"], "wide");
    const bottom = (rect: Rect | undefined) => (rect ? rect.y + rect.height : NaN);
    expect(bottom(places.phone)).toBe(bottom(places.mac));
  });

  it("other machines stand beside the Mac in a wide frame and under it in a tall one", () => {
    const cast: CastId[] = ["mac", "build", "workstation"];
    expect(chooseLayout(cast, { width: 1200, height: 560 })).toBe("wide");
    expect(chooseLayout(cast, { width: 600, height: 780 })).toBe("tall");
  });
});

describe("a step's camera", () => {
  const stage = { width: 640, height: 720 };

  it("a part of the window is framed whole, with room around it", () => {
    const part = { x: 400, y: 300, width: 300, height: 200 };
    const camera = shotCamera(part, "part", stage);
    expect(part.x * camera.scale + camera.x).toBeGreaterThan(0);
    expect((part.x + part.width) * camera.scale + camera.x).toBeLessThan(stage.width);
  });

  it("a small part is never drawn much larger than life", () => {
    const camera = shotCamera({ x: 0, y: 0, width: 80, height: 40 }, "part", stage);
    expect(camera.scale).toBeLessThanOrEqual(1.25);
  });

  it("a whole device leaves room above it for its label", () => {
    const mac = { x: 0, y: 0, ...castSizes.mac };
    const camera = shotCamera(mac, "device", stage);
    expect(camera.y).toBeGreaterThanOrEqual(40);
  });

  it("the camera eases out and in and arrives exactly", () => {
    expect(travelled(0)).toBe(0);
    expect(travelled(100)).toBeLessThan(100 / 1100);
    expect(travelled(5000)).toBe(1);
  });
});
