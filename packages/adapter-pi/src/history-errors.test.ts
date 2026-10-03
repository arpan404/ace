import { expect, test } from "vitest";
import { piHistoryErrorMessage } from "./index.ts";
test("provider exception text cannot leak through history diagnostics", () => {
  expect(piHistoryErrorMessage(new Error("private credential and native stderr"))).toBe(
    "Pi native history operation failed",
  );
});
