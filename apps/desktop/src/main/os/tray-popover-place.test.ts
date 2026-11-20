import { describe, expect, it } from "vitest";
import { popoverBounds, popoverWidth, reopensOnClick } from "./tray-popover-place.ts";

const screen = { x: 0, y: 25, width: 1512, height: 932 };

describe("menu-bar popover placement", () => {
  it("opens centred under a menu-bar icon", () => {
    const icon = { x: 1000, y: 0, width: 30, height: 24 };
    expect(popoverBounds(icon, screen, 420)).toEqual({
      x: 1015 - popoverWidth / 2,
      y: 31,
      width: popoverWidth,
      height: 420,
    });
  });

  it("stays on screen for an icon near the right edge", () => {
    const icon = { x: 1490, y: 0, width: 20, height: 24 };
    const bounds = popoverBounds(icon, screen, 420);
    expect(bounds.x + bounds.width).toBe(screen.width - 8);
  });

  it("opens above an icon in a taskbar at the bottom", () => {
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    const icon = { x: 1700, y: 1044, width: 24, height: 32 };
    const bounds = popoverBounds(icon, area, 400);
    expect(bounds.y + bounds.height).toBe(1040 - 6);
  });

  it("is never taller than the screen leaves room for", () => {
    const icon = { x: 500, y: 0, width: 30, height: 24 };
    expect(popoverBounds(icon, { x: 0, y: 25, width: 1280, height: 300 }, 900).height).toBe(284);
  });

  it("narrows on a display smaller than the popover", () => {
    const icon = { x: 100, y: 0, width: 30, height: 24 };
    const bounds = popoverBounds(icon, { x: 0, y: 25, width: 300, height: 600 }, 400);
    expect(bounds).toMatchObject({ x: 8, width: 284 });
  });
});

describe("a click on the icon while the popover is open", () => {
  it("closes it rather than opening it again", () => {
    expect(reopensOnClick(1_000, 1_100)).toBe(false);
  });

  it("opens it when it was closed a while ago or never opened", () => {
    expect(reopensOnClick(1_000, 2_000)).toBe(true);
    expect(reopensOnClick(undefined, 2_000)).toBe(true);
  });
});
