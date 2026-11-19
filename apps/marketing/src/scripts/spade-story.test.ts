import { describe, expect, it } from "vitest";
import { finishedAt, poseAt, showsAt } from "./spade-story.ts";

describe("which steps a piece of the scene shows in", () => {
  it("shows a single step only there", () => {
    expect(showsAt("3", 3)).toBe(true);
    expect(showsAt("3", 4)).toBe(false);
  });

  it("shows a range from its first to its last step", () => {
    expect([1, 2, 5, 6].map((step) => showsAt("2-5", step))).toEqual([false, true, true, false]);
  });

  it("keeps showing an open range to the story's end", () => {
    expect(showsAt("6-", 6)).toBe(true);
    expect(showsAt("6-", 60)).toBe(true);
    expect(showsAt("6-", 5)).toBe(false);
  });

  it("joins several spans", () => {
    expect([0, 1, 2, 3, 9].map((step) => showsAt("0-1, 9", step))).toEqual([
      true,
      true,
      false,
      false,
      true,
    ]);
  });

  it("hides a piece whose span doesn't parse, rather than showing it everywhere", () => {
    expect(showsAt("soon", 2)).toBe(false);
    expect(showsAt("", 0)).toBe(false);
  });
});

describe("a face's pose through the story", () => {
  const flights = "0:idle 2:working 3:needs-you 4:done";

  it("holds each pose from its step until the next one", () => {
    expect([0, 1, 2, 3, 4, 8].map((step) => poseAt(flights, step))).toEqual([
      "idle",
      "idle",
      "working",
      "needs-you",
      "done",
      "done",
    ]);
  });

  it("rests before its first pose and ignores poses it doesn't know", () => {
    expect(poseAt("2:working", 0)).toBe("idle");
    expect(poseAt("1:dancing 2:working", 1)).toBe("idle");
  });

  it("hops only on the step it finishes", () => {
    expect(finishedAt(flights, 4)).toBe(true);
    expect(finishedAt(flights, 5)).toBe(false);
    expect(finishedAt(flights, 3)).toBe(false);
  });
});
