import { describe, expect, it } from "vitest";
import { withAgentPointer, type Bitmap } from "./tray-glyph.ts";

/** A 36×36 icon (an 18pt menu-bar icon at 2x), fully opaque black. */
function icon(): Bitmap {
  const data = Buffer.alloc(36 * 36 * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width: 36, height: 36, data };
}

const alpha = (bitmap: Bitmap, x: number, y: number) =>
  bitmap.data[(y * bitmap.width + x) * 4 + 3] ?? 0;

describe("the menu-bar icon while an agent uses an app", () => {
  const drawn = withAgentPointer(icon());
  const pointer = { left: 36 + 5, right: drawn.width - 1, top: 6, bottom: 29 };

  it("keeps the icon as it was and adds the pointer beside it", () => {
    expect(drawn.height).toBe(36);
    expect(drawn.width).toBeGreaterThan(36 + 10);
    for (let y = 0; y < 36; y++) for (let x = 0; x < 36; x++) expect(alpha(drawn, x, y)).toBe(255);
  });

  it("leaves a gap between the icon and the pointer", () => {
    for (let y = 0; y < 36; y++) expect(alpha(drawn, 37, y)).toBe(0);
  });

  it("draws the pointer's body solid, pointing up and left, with nothing past its edge", () => {
    const solid = (x: number, y: number) => alpha(drawn, x, y) === 255;
    // The body, a third of the way in from the tip, is covered.
    const bodyX = Math.round(pointer.left + (pointer.right - pointer.left) * 0.35);
    const bodyY = Math.round(pointer.top + (pointer.bottom - pointer.top) * 0.35);
    expect(solid(bodyX, bodyY)).toBe(true);
    // The arrow leans up and left: its top-right and bottom-right corners are empty.
    expect(alpha(drawn, pointer.right, pointer.top)).toBe(0);
    expect(alpha(drawn, pointer.right, pointer.bottom)).toBe(0);
  });
});
