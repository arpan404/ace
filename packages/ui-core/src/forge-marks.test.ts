import { expect, test } from "vitest";
import { checksMark, issueStateMark, reviewMark } from "./forge-marks.ts";

test("a failing local check makes passing GitHub checks read as failing, and says so", () => {
  expect(checksMark("success", "failed")).toEqual({
    word: "Checks failing, local check failed",
    tone: "failed",
  });
  expect(checksMark("success", undefined)).toEqual({ word: "Checks passed", tone: "done" });
  expect(checksMark("pending", "passed")?.tone).toBe("working");
  expect(checksMark(undefined, undefined)).toBeUndefined();
});

test("a repository that requires no review shows no review mark", () => {
  expect(reviewMark(null)).toBeUndefined();
  expect(reviewMark("CHANGES_REQUESTED")).toEqual({ word: "Changes requested", tone: "failed" });
});

test("a closed issue reads as completed in the merged hue, an open one as open", () => {
  expect(issueStateMark("closed")).toEqual({ word: "Closed", tone: "waiting" });
  expect(issueStateMark("open").tone).toBe("done");
});
