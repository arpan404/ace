import { expect, test } from "vitest";
import { describeProviderError, echoesEarlierError, isBareErrorCode } from "./error-display.ts";

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

const notice = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "notice",
  level: "error",
  text,
  agentId: "root",
  runId: "run-1",
  ...extra,
});

function echoAt(items: ReturnType<typeof notice>[] | { id: string; type: string }[]) {
  const order = items.map((item) => item.id);
  return echoesEarlierError(order, order.length - 1, (id) => items.find((item) => item.id === id));
}

test("a bare code right after the error it repeats is an echo", () => {
  expect(
    echoAt([
      notice("a", '[claude-code:unrecognized_model] {"model":"opus-5.5"}'),
      notice("b", "model_not_found"),
    ]),
  ).toBe(true);
});

test("an independent failure after another error still shows", () => {
  expect(
    echoAt([notice("a", "Not signed in", { code: "auth" }), notice("b", "model_not_found")]),
  ).toBe(false);
});

test("the same code from another run, another agent or after work in between shows", () => {
  const error = notice("a", '[claude-code:unrecognized_model] {"model":"x"}');
  expect(echoAt([error, notice("b", "model_not_found", { runId: "run-2" })])).toBe(false);
  expect(echoAt([error, notice("b", "model_not_found", { agentId: "child" })])).toBe(false);
  expect(echoAt([error, { id: "m", type: "message" }, notice("b", "model_not_found")])).toBe(false);
});
