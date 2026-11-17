import { expect, test } from "vitest";
import type { ProviderLoginProgress } from "@ace/protocol";
import { loginPrompt, loginStep } from "./provider-login-steps.ts";

const progress = (extra: Partial<ProviderLoginProgress>): ProviderLoginProgress => ({
  session: "s1",
  provider: "opencode",
  action: "login",
  state: "starting",
  expiresAt: 1,
  sequence: 0,
  ...extra,
});
const agent = { interactive: false };
const person = { interactive: true };
const choices = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
];

test.each(["starting", "awaiting_browser", "verifying", "awaiting_code_entry"] as const)(
  "%s keeps waiting for the browser to finish",
  (state) => {
    expect(loginStep(progress({ state }), agent, "OpenCode").kind).toBe("wait");
  },
);

test("a finished sign-in is done", () => {
  expect(loginStep(progress({ state: "succeeded" }), agent, "OpenCode")).toEqual({ kind: "done" });
});

test("--choice answers the provider's question with that service", () => {
  expect(
    loginStep(
      progress({ state: "awaiting_input", choices }),
      { ...agent, choice: "openai" },
      "OpenCode",
    ),
  ).toEqual({ kind: "send", input: { choice: "openai" } });
});

test("a person at a terminal picks the service; an agent is told to pass --choice (exit 2)", () => {
  expect(loginStep(progress({ state: "awaiting_input", choices }), person, "OpenCode")).toEqual({
    kind: "choose",
    choices,
  });
  expect(loginStep(progress({ state: "awaiting_input", choices }), agent, "OpenCode")).toEqual({
    kind: "stop",
    outcome: "needs-human",
    message: "OpenCode asks which service to connect.",
    hint: "Pass --choice ID: anthropic, openai.",
  });
});

test("a choice the provider doesn't offer stops with the ones it does", () => {
  const step = loginStep(
    progress({ state: "awaiting_input", choices }),
    { ...agent, choice: "nope" },
    "OpenCode",
  );
  expect(step).toMatchObject({ kind: "stop", outcome: "needs-human", hint: /anthropic, openai/ });
});

test("an API-key sign-in hands back to the person", () => {
  expect(loginStep(progress({ state: "awaiting_api_key" }), person, "Pi")).toMatchObject({
    kind: "stop",
    outcome: "needs-human",
  });
});

test("a failed sign-in is a failure naming the provider's message", () => {
  expect(
    loginStep(progress({ state: "failed", message: "Network down." }), agent, "Codex"),
  ).toMatchObject({
    kind: "stop",
    outcome: "failed",
    message: "Codex sign-in failed: Network down.",
  });
});

test("the address and device code are printed for the person to open", () => {
  expect(
    loginPrompt(progress({ url: "https://auth.example/device", userCode: "ABCD-EFGH" }), "Codex"),
  ).toEqual([
    "Open this address to sign in to Codex:",
    "https://auth.example/device",
    "Enter the code ABCD-EFGH",
  ]);
});
