import { expect, it } from "vitest";
import { audioMuted } from "./audio.ts";

it("only the tab the person watches plays, unless an agent uses it", () => {
  expect(audioMuted({ shown: true, agentControl: false })).toBe(false);
  expect(audioMuted({ shown: false, agentControl: false })).toBe(true);
  expect(audioMuted({ shown: true, agentControl: true })).toBe(true);
  expect(audioMuted({ shown: false, agentControl: true })).toBe(true);
});

it("the person's own choice for a tab holds wherever the tab is", () => {
  expect(audioMuted({ shown: false, agentControl: true, chosen: false })).toBe(false);
  expect(audioMuted({ shown: true, agentControl: false, chosen: true })).toBe(true);
});
