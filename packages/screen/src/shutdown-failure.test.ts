import { expect, test } from "vitest";
import { shutdownFailure } from "./shutdown-failure.ts";

test("a failed shutdown says how many sessions didn't stop and why, each reason once", () => {
  const error = shutdownFailure(
    [new Error("helper timed out"), new Error("helper timed out"), new Error("window gone")],
    5,
  );
  expect(error.message).toBe("3 of 5 app sessions didn't stop: helper timed out; window gone");
  expect(error.errors).toHaveLength(3);
});

test("many distinct reasons are named up to three and the rest counted", () => {
  const error = shutdownFailure(
    ["a", "b", "c", "d"].map((reason) => new Error(reason)),
    4,
  );
  expect(error.message).toBe("4 of 4 app sessions didn't stop: a; b; c (and 1 more)");
});
