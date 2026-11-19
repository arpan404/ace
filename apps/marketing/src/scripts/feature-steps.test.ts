import { describe, expect, it } from "vitest";
import { moveAt, onStage, readFocus, startsMove, type StepPlan } from "./feature-steps.ts";

const plan: StepPlan[] = [
  { move: "review", focus: ["threads"] },
  { move: "keep", focus: ["changes"] },
  { move: "keep", focus: ["commit"] },
  { move: "approval", focus: ["mac", "phone"] },
];

describe("a feature page's steps", () => {
  it("a step that keeps going shows the scene of the step before it", () => {
    expect(moveAt(plan, 2)).toBe("review");
    expect(moveAt(plan, 3)).toBe("approval");
  });

  it("a story that opens by keeping starts from rest", () => {
    expect(moveAt([{ move: "keep", focus: ["mac"] }], 0)).toBe("rest");
  });

  it("scrolling within a run of kept steps lets the playing scene go on", () => {
    expect(startsMove(plan, 2, "review")).toBeUndefined();
  });

  it("landing mid-story starts the scene that step belongs to", () => {
    expect(startsMove(plan, 2, undefined)).toBe("review");
    expect(startsMove(plan, 1, "approval")).toBe("review");
  });

  it("frames hardware when a step names any, and one part of the window otherwise", () => {
    expect(readFocus(["mac", "phone"])).toEqual({ kind: "device", cast: ["mac", "phone"] });
    expect(readFocus(["dock"])).toEqual({ kind: "part", part: "dock" });
  });

  it("other hardware is on stage only while a step frames it, and leaves again going back", () => {
    const cast = ["mac", "build", "phone"] as const;
    const story: StepPlan[] = [
      { move: "team", focus: ["thread"] },
      { move: "agents", focus: ["mac", "build"] },
      { move: "keep", focus: ["dock"] },
      { move: "phone", focus: ["mac", "phone"] },
    ];
    expect(onStage(story, 0, cast)).toEqual(["mac"]);
    expect(onStage(story, 1, cast)).toEqual(["mac", "build"]);
    expect(onStage(story, 2, cast)).toEqual(["mac"]);
    expect(onStage(story, 3, cast)).toEqual(["mac", "phone"]);
  });

  it("a step about one other device stands it alone, without the Mac", () => {
    expect(onStage([{ move: "phone-ask", focus: ["phone"] }], 0, ["mac", "phone"])).toEqual([
      "phone",
    ]);
  });

  it("a step can only bring on hardware the story stands", () => {
    expect(onStage([{ move: "rest", focus: ["mac", "workstation"] }], 0, ["mac"])).toEqual(["mac"]);
  });
});
