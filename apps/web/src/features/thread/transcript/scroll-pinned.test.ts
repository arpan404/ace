import { expect, test } from "vitest";
import { pinnedMove } from "./scroll.ts";

const none = { height: false, width: false, clearance: false };

test("the composer growing keeps the live end in view at once, never gliding behind it", () => {
  expect(pinnedMove({ ...none, clearance: true })).toBe("jump");
  // The composer's growth can come with a height change in the same frame: still at once.
  expect(pinnedMove({ height: true, width: false, clearance: true })).toBe("jump");
});

test("a panel or window resize glides back to the live end", () => {
  expect(pinnedMove({ ...none, height: true })).toBe("glide");
  expect(pinnedMove({ ...none, width: true })).toBe("glide");
});

test("a resize delivery that changed nothing moves nothing", () => {
  expect(pinnedMove(none)).toBe("none");
});
