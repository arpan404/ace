import { describe, expect, it } from "vitest";
import { rosterDial, rosterReach, turn } from "./roster-dial.ts";
import { dialSeats } from "./zoom-camera.ts";

const composer = { x: 0, y: 100, width: 400, height: 112 };
const chip = { width: 184, height: 40 };

describe("roster dial", () => {
  it("seats the chosen agent level with the composer, a reach from its edge", () => {
    const seats = dialSeats(rosterDial(composer), 6, 2, chip);
    const chosen = seats[2];
    expect(chosen?.x).toBeCloseTo(400 + rosterReach);
    expect((chosen?.y ?? 0) + chip.height / 2).toBeCloseTo(156);
    expect(chosen?.opacity).toBe(1);
  });

  it("curves the neighbours back toward the composer, one above and one below", () => {
    const [before, chosen, after] = dialSeats(rosterDial(composer), 6, 1, chip);
    for (const seat of [before, after]) expect(seat?.x).toBeLessThan(chosen?.x ?? 0);
    expect(before?.y).toBeLessThan(chosen?.y ?? 0);
    expect(after?.y).toBeGreaterThan(chosen?.y ?? 0);
  });

  it("keeps every chip in sight clear of the composer", () => {
    for (const seat of dialSeats(rosterDial(composer), 17, 0, chip)) {
      if (seat.opacity > 0) expect(seat.x).toBeGreaterThan(composer.x + composer.width);
    }
  });

  it("turns to the next agent and wraps round at either end", () => {
    expect(turn(2, 6, "ArrowDown")).toBe(3);
    expect(turn(2, 6, "ArrowRight")).toBe(3);
    expect(turn(5, 6, "ArrowDown")).toBe(0);
    expect(turn(0, 6, "ArrowUp")).toBe(5);
    expect(turn(3, 6, "ArrowLeft")).toBe(2);
  });

  it("jumps to the ends with Home and End and ignores other keys", () => {
    expect(turn(3, 17, "Home")).toBe(0);
    expect(turn(3, 17, "End")).toBe(16);
    expect(turn(3, 17, "Enter")).toBeUndefined();
    expect(turn(0, 0, "ArrowDown")).toBeUndefined();
  });
});
