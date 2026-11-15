import { describe, expect, it } from "vitest";
import {
  overflowProblems,
  protectedProblems,
  type OverflowSample,
  type ProtectedSample,
} from "./layout-check.ts";

const shown = (overrides: Partial<ProtectedSample>): ProtectedSample => ({
  part: "working-line",
  box: { left: 0, top: 0, width: 300, height: 20 },
  display: "flex",
  visibility: "visible",
  opacity: 1,
  hit: true,
  ...overrides,
});

describe("protected parts", () => {
  it.each<[string, Partial<ProtectedSample>, RegExp | undefined]>([
    ["shown whole and on top", {}, undefined],
    ["display none", { display: "none" }, /display: none/],
    ["visibility hidden", { visibility: "hidden" }, /visibility: hidden/],
    ["faded by a container", { opacity: 0.6 }, /opacity 0\.60/],
    ["squashed below its minimum", { box: { left: 0, top: 0, width: 300, height: 4 } }, /300×4 px/],
    ["covered at its centre", { hit: false }, /covered/],
    // Scrolled out of view can't be hit-tested, and isn't the Suit's doing.
    ["scrolled out of the window", { hit: "offscreen" }, undefined],
  ])("%s", (_name, overrides, message) => {
    const problems = protectedProblems([shown(overrides)], "dark");
    if (!message) expect(problems).toEqual([]);
    else
      expect(problems).toEqual([
        {
          scheme: "dark",
          check: "protected",
          field: "working-line",
          message: expect.stringMatching(message),
        },
      ]);
  });

  it("each part is named once, by its first failure", () => {
    const problems = protectedProblems(
      [shown({ part: "status-icon", hit: false }), shown({ part: "status-icon", opacity: 0 })],
      "light",
    );
    expect(problems.map((problem) => problem.field)).toEqual(["status-icon"]);
  });
});

const inside = (overrides: Partial<OverflowSample>): OverflowSample => ({
  part: "composer-toolbar",
  region: "composer",
  box: { left: 10, top: 0, width: 200, height: 30 },
  regionBox: { left: 0, top: 0, width: 400, height: 100 },
  scrolls: false,
  spills: false,
  ...overrides,
});

describe("overflow", () => {
  it.each<[string, Partial<OverflowSample>, number]>([
    ["inside its region", {}, 0],
    [
      "half a pixel past the edge (rounding)",
      { box: { left: 0, top: 0, width: 400.5, height: 30 } },
      0,
    ],
    ["past the right edge", { box: { left: 100, top: 0, width: 400, height: 30 } }, 1],
    ["past the left edge", { box: { left: -20, top: 0, width: 100, height: 30 } }, 1],
    [
      "past the edge inside a sideways scroller",
      { box: { left: 100, top: 0, width: 400, height: 30 }, scrolls: true },
      0,
    ],
    ["content spilling out of it", { spills: true }, 1],
  ])("%s", (_name, overrides, count) => {
    const problems = overflowProblems(
      [{ width: 1280, simulated: false, samples: [inside(overrides)] }],
      "dark",
    );
    expect(problems).toHaveLength(count);
  });

  it("names every width a part spills at, saying which were simulated", () => {
    const wide = inside({ box: { left: 100, top: 0, width: 400, height: 30 } });
    const problems = overflowProblems(
      [
        { width: 1440, simulated: false, samples: [inside({})] },
        { width: 1024, simulated: true, samples: [wide] },
        { width: 760, simulated: true, samples: [wide] },
      ],
      "dark",
    );
    expect(problems).toEqual([
      {
        scheme: "dark",
        check: "overflow",
        field: "composer-toolbar",
        message: expect.stringContaining("at 1024 px (simulated), 760 px (simulated)"),
      },
    ]);
  });
});
