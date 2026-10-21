import { expect, it } from "vitest";
import { providerSlots } from "./provider-slots.ts";

it("shows each provider once, in launch order", () => {
  expect(providerSlots(["claude", "codex", "claude", "claude"])).toEqual({
    shown: ["claude", "codex"],
    more: 0,
    label: "Claude Code and Codex",
  });
});

it("shows three providers when there are exactly three", () => {
  const lead = providerSlots(["cursor", "claude", "codex", "cursor"]);
  expect(lead.shown).toEqual(["cursor", "claude", "codex"]);
  expect(lead.more).toBe(0);
});

it("past three providers, the first two show and the third slot counts the rest", () => {
  expect(providerSlots(["claude", "codex", "cursor", "pi", "claude", "opencode"])).toEqual({
    shown: ["claude", "codex"],
    more: 3,
    label: "Claude Code, Codex and 3 more",
  });
});

it("an agent whose provider isn't known yet takes a slot of its own", () => {
  expect(providerSlots([undefined, "codex", undefined])).toEqual({
    shown: [undefined, "codex"],
    more: 0,
    label: "Unknown agent and Codex",
  });
});
