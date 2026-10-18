import { expect, it } from "vitest";
import { agentWork, quitNeedsConfirmation } from "./quit-guard.ts";

const facts = { working: 1, lastAgentBrowse: 100_000, now: 110_000, systemShutdown: false };

it("Quit asks first only while working agents have just been using a browser page", () => {
  expect(quitNeedsConfirmation(facts)).toBe(true);
  // Agents working, but none in a page lately; or a page used, but nobody working now.
  expect(quitNeedsConfirmation({ ...facts, now: 100_000 + 61_000 })).toBe(false);
  expect(quitNeedsConfirmation({ ...facts, working: 0 })).toBe(false);
  expect(quitNeedsConfirmation({ ...facts, lastAgentBrowse: -Infinity })).toBe(false);
});

it("a system shutdown or logout is never held up by the question", () => {
  expect(quitNeedsConfirmation({ ...facts, systemShutdown: true })).toBe(false);
});

it("an agent's reads and actions count as browsing; request decisions and frames do not", () => {
  for (const method of ["Input.dispatchMouseEvent", "Page.navigate", "Accessibility.getFullAXTree"])
    expect(agentWork(method)).toBe(true);
  for (const method of ["Fetch.continueRequest", "Page.screencastFrameAck", "Runtime.enable"])
    expect(agentWork(method)).toBe(false);
});
