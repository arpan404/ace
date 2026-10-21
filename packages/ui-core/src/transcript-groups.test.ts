import { expect, it } from "vitest";
import { mergesWith, type GroupEntry } from "./index.ts";

const entry = (overrides: Partial<GroupEntry> = {}): GroupEntry => ({
  kind: "background",
  agentId: "root",
  runId: "run-1",
  ...overrides,
});

it("consecutive items of one kind by one agent in one run merge", () => {
  for (const kind of ["subagents", "tool", "background", "edit"] as const)
    expect(mergesWith(entry({ kind }), entry({ kind }))).toBe(true);
});

it("a different kind, agent or run starts a new group", () => {
  expect(mergesWith(entry({ kind: "background" }), entry({ kind: "subagents" }))).toBe(false);
  expect(mergesWith(entry(), entry({ agentId: "child" }))).toBe(false);
  expect(mergesWith(entry(), entry({ runId: "run-2" }))).toBe(false);
});

it("prose, a person's message, a question or an error ends a group and stands alone", () => {
  for (const kind of ["prose", "user", "question", "error"] as const) {
    expect(mergesWith(entry(), entry({ kind }))).toBe(false);
    expect(mergesWith(entry({ kind }), entry())).toBe(false);
    expect(mergesWith(entry({ kind }), entry({ kind }))).toBe(false);
  }
});

it("the first item of a transcript has nothing to join: a group of one", () => {
  expect(mergesWith(undefined, entry())).toBe(false);
});
