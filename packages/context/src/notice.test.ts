import { expect, test } from "vitest";
import { contextNotice } from "./index.ts";
test("a shortened file explains how to include the needed lines without exposing diagnostic details", () => {
  expect(
    contextNotice({
      code: "truncated",
      path: "src/router.ts",
      message: "budgetBytes=1024, omitted=4096",
    }),
  ).toBe(
    "Only part of src/router.ts fit in this message. Mention a smaller line range to include the part you need.",
  );
});
test("shortened mixed context and unavailable files each offer a next action", () => {
  expect(contextNotice({ code: "truncated", message: "limit" })).toContain(
    "Reference a smaller section",
  );
  expect(contextNotice({ code: "not_found", path: "notes.md", message: "ENOENT" })).toBe(
    "notes.md couldn't be included because it is no longer available. Choose the file again.",
  );
});
