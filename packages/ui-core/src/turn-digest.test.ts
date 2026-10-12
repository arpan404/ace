import { TurnDigest } from "@ace/protocol";
import { expect, test } from "vitest";
import type { z } from "zod";
import { digestFacts, turnHeadline, turnSpan } from "./turn-digest.ts";

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
const texts = (d: TurnDigest) => digestFacts(d).map((fact) => fact.text);

test("a digest reads as steps, files with their lines, failures, approvals and subagents", () => {
  const facts = digestFacts(
    digest({
      toolCounts: { shell: 9, "file.edit": 5 },
      files: [
        { path: "a.ts", added: 10, removed: 2 },
        { path: "b.ts", added: 2, removed: 2 },
      ],
      commandsRun: 9,
      commandsFailed: 1,
      approvalsAsked: 2,
      approvalsPending: 1,
      subagentsStarted: 1,
      errors: 3,
    }),
  );
  expect(facts.map((fact) => fact.text)).toEqual([
    "14 steps",
    "2 files",
    "+12 −4",
    "1 failed",
    "2 approvals",
    "1 waiting on you",
    "1 subagent",
    // Three errors, one of them the failed command already counted.
    "2 errors",
  ]);
  expect(facts.find((fact) => fact.kind === "failed")?.tone).toBe("failed");
  expect(facts.find((fact) => fact.kind === "waiting")?.tone).toBe("needs-you");
});

test("lines stay unsaid when a file's count is unknown, rather than understated", () => {
  expect(
    texts(
      digest({
        files: [
          { path: "a.ts", added: 10, removed: 2 },
          { path: "b.ts", added: null, removed: null },
        ],
      }),
    ),
  ).toEqual(["2 files"]);
});

test("a digest that left files out says so", () => {
  const files = Array.from({ length: 64 }, (_, n) => ({ path: `f${n}`, added: 1, removed: 0 }));
  expect(texts(digest({ files, truncated: true }))[0]).toBe("64+ files");
});

test("a quiet turn has no facts and large counts are grouped", () => {
  expect(texts(digest())).toEqual([]);
  expect(texts(digest({ toolCounts: { shell: 12_400 } }))).toEqual(["12,400 steps"]);
});

test("a running turn's span grows with the clock; a finished one's is fixed", () => {
  expect(turnSpan({ startedAt: 0, endedAt: 90_000 }, 10_000_000)).toBe("1m");
  expect(turnSpan({ startedAt: 0 }, 4 * 3_600_000 + 60_000)).toBe("4h 1m");
  // A turn over in under a second says nothing rather than "0s".
  expect(turnSpan({ startedAt: 0, endedAt: 400 }, 10_000)).toBe("");
});

test("a turn's headline is its ask on one line, else what the agent said", () => {
  expect(
    turnHeadline({ initiatingMessagePreview: "Fix the\n  relay", latestAgentMessagePreview: "" }),
  ).toBe("Fix the relay");
  expect(turnHeadline({ initiatingMessagePreview: "", latestAgentMessagePreview: "Done." })).toBe(
    "Done.",
  );
  expect(turnHeadline({ initiatingMessagePreview: " ", latestAgentMessagePreview: "" })).toBe(
    "Automatic turn",
  );
});
