import { TurnDigest } from "@ace/protocol";
import { expect, test } from "vitest";
import type { z } from "zod";
import { catchUpFacts, catchUpLines } from "./catch-up.ts";

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

test("since you looked keeps the agent's latest words last, in at most four lines", () => {
  const busy = {
    ready: true,
    turnsCompleted: 2,
    digest: digest({
      files: [{ path: "a.ts", added: 1, removed: 0 }],
      commandsRun: 3,
      commandsFailed: 1,
      errors: 2,
      approvalsPending: 1,
    }),
  };
  expect(
    catchUpLines({ ...busy, latestAgentMessagePreview: "  Fixed the\n  login bug. " }),
  ).toEqual([
    { text: "2 turns finished" },
    { text: "1 file changed" },
    { text: "1 command failed", tone: "failed" },
    { text: "Fixed the login bug." },
  ]);
  expect(catchUpLines({ ...busy, latestAgentMessagePreview: "" }).map((line) => line.text)).toEqual(
    ["2 turns finished", "1 file changed", "1 command failed", "1 error"],
  );
  expect(catchUpLines({ ...busy, ready: false, latestAgentMessagePreview: "Done." })).toEqual([]);
});
