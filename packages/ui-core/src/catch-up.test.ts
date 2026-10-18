import { TurnDigest } from "@ace/protocol";
import { expect, test } from "vitest";
import type { z } from "zod";
import { catchUpFacts } from "./catch-up.ts";

const digest = (patch: Partial<z.input<typeof TurnDigest>> = {}): TurnDigest =>
  TurnDigest.parse({
    toolCounts: {},
    files: [],
    commands: [],
    commandsRun: 0,
    commandsFailed: 0,
    approvalsAsked: 0,
    approvalsAnswered: 0,
    approvalsAutoReviewed: 0,
    approvalsPending: 0,
    subagentsStarted: 0,
    subagentsFinished: 0,
    inputTokens: null,
    outputTokens: null,
    errors: 0,
    truncated: false,
    ...patch,
  });

test("a catch-up says how many turns finished, files changed and what failed", () => {
  const facts = catchUpFacts({
    ready: true,
    turnsCompleted: 3,
    digest: digest({
      files: [
        { path: "a.ts", added: 1, removed: 0 },
        { path: "b.ts", added: 1, removed: 0 },
      ],
      commandsFailed: 1,
      errors: 2,
    }),
  });
  expect(facts).toEqual([
    { text: "3 turns finished" },
    { text: "2 files changed" },
    { text: "1 command failed", tone: "failed" },
    { text: "1 error", tone: "failed" },
  ]);
});

test("nothing to catch up on, or an index still catching up, says nothing", () => {
  expect(catchUpFacts({ ready: true, turnsCompleted: 0, digest: digest() })).toEqual([]);
  expect(catchUpFacts({ ready: false, turnsCompleted: 4, digest: digest() })).toEqual([]);
});
