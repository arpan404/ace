import { expect, test } from "vitest";
import { describeProviderError, isBareErrorCode } from "./error-display.ts";

test("a tagged provider error reads in words with the action that fixes it", () => {
  const view = describeProviderError({
    text: '[claude-code:unrecognized_model] {"model":"opus-5.5","message":"not found"}',
  });
  expect(view).toMatchObject({
    title: "Claude Code doesn't recognise the model “opus-5.5”",
    action: "change_model",
    code: "model_not_found",
  });
  expect(view.raw).toContain("unrecognized_model");
});

test("structured codes win over the text, and known kinds get their own words", () => {
  expect(describeProviderError({ text: "401", code: "auth", provider: "codex" })).toMatchObject({
    title: "Not signed in to Codex",
    action: "sign_in",
  });
  expect(describeProviderError({ text: "You hit your limit", code: "quota" })).toMatchObject({
    title: "Usage limit reached",
    message: "You hit your limit",
    action: "switch_account",
  });
  expect(describeProviderError({ text: "ECONNRESET", kind: "network" }).title).toBe(
    "Network trouble",
  );
});

test("an unknown failure keeps its own first line, never an empty row", () => {
  expect(describeProviderError({ text: "2 tests failing on #74" }).title).toBe(
    "2 tests failing on #74",
  );
  expect(describeProviderError({ text: "" }).title).toBe("Something went wrong");
});

test("a notice that is only a code is recognised as the echo of an error", () => {
  expect(isBareErrorCode("model_not_found")).toBe(true);
  expect(isBareErrorCode("Model not found")).toBe(false);
});
