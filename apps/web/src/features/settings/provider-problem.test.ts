import { turnedOffView, type ReadinessView } from "@ace/ui-core";
import { expect, test } from "vitest";
import { providerProblem } from "./provider-problem.ts";

const view = (
  state: ReadinessView["state"],
  extra: Partial<ReadinessView> = {},
): ReadinessView => ({
  state,
  ready: state === "ready",
  label: "",
  summary: "",
  tone: state === "ready" ? "ready" : "action",
  more: [],
  ...extra,
});

test.each([
  ["missing", { missing: true, view: undefined }, "install"],
  ["turned off", { missing: false, view: turnedOffView }, "turn_on"],
  ["signed out", { missing: false, view: view("signed_out", { primary: "sign_in" }) }, "sign_in"],
  [
    "sign-in expired",
    { missing: false, view: view("attention", { primary: "reconnect" }) },
    "reconnect",
  ],
  // Every account at its limit: nothing to press until the reset.
  [
    "at its limit",
    { missing: false, view: view("attention", { detail: "No account is ready." }) },
    undefined,
  ],
  [
    "needing an update, which the header offers",
    { missing: false, view: view("needs_update") },
    undefined,
  ],
] as const)("a provider %s offers the matching fix", (_, input, fix) => {
  const problem = providerProblem({ provider: "codex", name: "Codex", ...input });
  expect(problem?.text).toBeTruthy();
  expect(problem?.fix).toBe(fix);
});

test("a ready provider has no problem line, and an ACP agent that reports nothing asks to sign in once accounts load", () => {
  expect(
    providerProblem({ provider: "codex", name: "Codex", missing: false, view: view("ready") }),
  ).toBeUndefined();
  expect(
    providerProblem({ provider: "acp", name: "Gemini CLI", missing: false, view: undefined }),
  ).toBeUndefined();
  expect(
    providerProblem({
      provider: "acp",
      name: "Gemini CLI",
      missing: false,
      view: undefined,
      accountsLoaded: true,
    })?.fix,
  ).toBe("sign_in");
});
