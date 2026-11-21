import { expect, it } from "vitest";
import { fatalDetail, fatalLine } from "./host-fatal.ts";
import { safeCursorErrorMessage } from "./sdk-failure.ts";
import { replay } from "./translator-test-support.ts";

const bearer = "7f3a9c1e5b8d2f4a6c0e9b7d5f3a1c8e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a";

it("a fenced turn's end keeps the fence's own cause, not a generic budget failure", () => {
  const r = replay();
  r.frame("error", {
    code: "checkpoint_budget",
    message: "ace could not write Cursor's checkpoint: disk full. Execution is fenced.",
  });
  expect(r.state.processExit).toMatchObject({
    deliberate: false,
    message: "ace could not write Cursor's checkpoint: disk full. Execution is fenced.",
  });
});

// The bearer starts 10 characters before the 2,048-character cut of the fatal detail.
const straddling = `failed ${"x".repeat(2048 - "uncaughtException: TypeError: failed ".length - 10)} ${bearer} tail`;

it("a host that knows the bearer redacts it before its fatal line is cut", () => {
  const line = fatalLine("uncaughtException", new TypeError(straddling), (text) =>
    safeCursorErrorMessage(text, { ACE_MCP_BEARER: bearer }),
  );
  expect(fatalDetail(line)).toMatch(/^uncaughtException: TypeError: failed x/);
  expect(line).not.toContain(bearer.slice(0, 8));
});

// Before open the host has not been given the bearer; the daemon, which has, redacts the line
// again, but only a whole bearer matches.
it("a fatal line cut inside a word drops that word, so the daemon never meets a bearer fragment", () => {
  const line = fatalLine("uncaughtException", new TypeError(straddling), (text) => text);
  expect(fatalDetail(line)).toMatch(/^uncaughtException: TypeError: failed x+$/);
  expect(line).not.toContain(bearer.slice(0, 8));
});
