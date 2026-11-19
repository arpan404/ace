import { expect, test } from "vitest";
import { rowAttention } from "./row-attention.ts";
import { rowStatusLook } from "./row-status-display.ts";
import { rowStatusState } from "./row-status-state.ts";
import type { Tone } from "./status.ts";

/** A row's state as a summary counts it, from the card's status as the inbox row reads it. */
function stateOf(
  label: string,
  tone: Tone,
  extra: { waitingOn?: number; unread?: boolean; recovery?: boolean } = {},
) {
  const attention = rowAttention({
    tone,
    word: label,
    unread: extra.unread ?? false,
    settled: false,
    recovery: extra.recovery,
  });
  const look = rowStatusLook(attention, { status: { label, tone, waitingOn: extra.waitingOn } });
  return rowStatusState(attention, look);
}

test("only work under way counts as working; waits, limits and background work are their own", () => {
  expect(stateOf("Working", "working")).toBe("working");
  expect(stateOf("Queued", "waiting")).toBe("waiting");
  expect(stateOf("Waiting for the network", "waiting")).toBe("waiting");
  expect(stateOf("Limited 14:02", "waiting")).toBe("limited");
  expect(stateOf("Resumes at 10:00 PM", "waiting")).toBe("limited");
  expect(stateOf("1 command running", "background")).toBe("background");
});

test("a turn that ended while its subagents still work counts as working", () => {
  expect(stateOf("Waiting for 2 subagents", "waiting", { waitingOn: 2 })).toBe("working");
});

test("a recovery the person must act on needs them; one that only waits stays a wait", () => {
  expect(stateOf("Not sent", "failed", { recovery: true })).toBe("needs-you");
  expect(stateOf("Queue paused", "waiting", { recovery: true })).toBe("waiting");
});

test("results, failures and rest read as what they are, never as working", () => {
  expect(stateOf("Approve", "needs-you")).toBe("needs-you");
  expect(stateOf("Failed", "failed", { unread: true })).toBe("failed");
  expect(stateOf("Failed", "failed")).toBe("idle");
  expect(stateOf("Done", "done", { unread: true })).toBe("finished");
  expect(stateOf("Done", "done")).toBe("idle");
});
