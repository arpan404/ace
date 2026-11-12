import { expect, test } from "vitest";
import { milestoneDue, prCreateNotice } from "./new-pr-words.ts";

test("a milestone's due date reads as the day GitHub set, whatever the reader's time zone", () => {
  // GitHub stores a due date as midnight UTC; read in a zone west of UTC it must not slip a day.
  expect(milestoneDue("2026-11-20T00:00:00Z", "en-US")).toBe("Due Nov 20, 2026");
  expect(milestoneDue("2026-01-01T00:00:00Z", "en-US")).toBe("Due Jan 1, 2026");
});

test("a milestone without a due date, or with one that isn't a date, says nothing", () => {
  expect(milestoneDue(null, "en-US")).toBeNull();
  expect(milestoneDue("soon", "en-US")).toBeNull();
});

test("a pull request opened without all its details says so, naming the pull request", () => {
  expect(
    prCreateNotice({ number: 241, existing: false, code: "forge_pr_details_incomplete" }),
  ).toEqual({
    title: "Opened pull request #241",
    detail:
      "The pull request is open, but GitHub didn't take all of its reviewers, labels, assignees or milestone: set them on its page.",
    warning: true,
  });
});

test("branches that already had a pull request say which; a clean create says nothing", () => {
  expect(prCreateNotice({ number: 233, existing: true, code: undefined })).toEqual({
    title: "This branch already has pull request #233",
    detail: null,
    warning: false,
  });
  expect(prCreateNotice({ number: 241, existing: false, code: undefined })).toBeUndefined();
});
