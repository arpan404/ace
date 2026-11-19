import { expect, test } from "vitest";
import { updateFailure } from "./update-outcome.ts";

test.each([
  [
    "Active threads block update",
    { busy: true, error: "Agents were still working when the update's wait ran out." },
  ],
  [
    "Candidate health check failed",
    { error: "The new version didn't start, so ace went back to 1.0.0." },
  ],
  ["Release is not newer", { error: "This machine already runs that release or a newer one." }],
  ["Missing release asset linux-x64.json", { error: "Missing release asset linux-x64.json" }],
])("an updater failure %j reads as words for the person", (message, expected) => {
  expect(updateFailure(new Error(message), "1.0.0")).toMatchObject({ ok: false, ...expected });
});

test("only agents outlasting the wait count as busy, so an update when idle tries again", () => {
  expect(updateFailure(new Error("Candidate health check failed"), "1.0.0").busy).toBeUndefined();
});
