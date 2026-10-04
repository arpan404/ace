import { TurnDigest } from "@ace/protocol";
import { expect, test } from "vitest";
import type { z } from "zod";
import { catchUpHasNews, catchUpView } from "./catch-up.ts";
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

test("a digest reads as tools, files with their lines, failures, approvals and subagents", () => {
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
    "14 tools",
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
  expect(texts(digest({ toolCounts: { shell: 12_400 } }))).toEqual(["12,400 tools"]);
});

test("a running turn's span grows with the clock; a finished one's is fixed", () => {
  expect(turnSpan({ startedAt: 0, endedAt: 90_000 }, 10_000_000)).toBe("1m");
  expect(turnSpan({ startedAt: 0 }, 4 * 3_600_000 + 60_000)).toBe("4h 1m");
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

test("catch-up lists failed commands and the first files, and counts the rest", () => {
  const view = catchUpView({
    turnsCompleted: 3,
    status: { state: "needs_you", interactions: 1 },
    latestAgentMessagePreview: "Checkpoint 12\ncompleted.",
    digest: digest({
      files: Array.from({ length: 7 }, (_, n) => ({ path: `src/f${n}.ts`, added: n, removed: 0 })),
      commands: [
        { itemId: "c1", command: "bun run test", failed: false, exitCode: 0 },
        { itemId: "c2", command: "git diff --check", failed: true, exitCode: 1 },
      ],
      commandsRun: 2,
      commandsFailed: 1,
      subagentsStarted: 3,
      subagentsFinished: 2,
      approvalsPending: 1,
    }),
  });
  expect(view.headline).toBe("3 turns finished");
  expect(view.files.map((file) => file.path)).toEqual([
    "src/f0.ts",
    "src/f1.ts",
    "src/f2.ts",
    "src/f3.ts",
  ]);
  expect(view.moreFiles).toBe(3);
  expect(view.failedCommands).toEqual([{ itemId: "c2", command: "git diff --check", exitCode: 1 }]);
  expect(view.commandLine).toBe("Ran 2 commands, 1 failed");
  expect(view.subagentLine).toBe("2 of 3 subagents finished");
  expect(view.latestMessage).toBe("Checkpoint 12 completed.");
  expect(view.pendingApprovals).toBe(1);
});

test("catch-up has news only when something happened or waits on the person", () => {
  const quiet = {
    turnsCompleted: 0,
    status: { state: "done" as const },
    latestAgentMessagePreview: "",
  };
  expect(catchUpHasNews({ ...quiet, digest: digest() })).toBe(false);
  expect(catchUpHasNews({ ...quiet, digest: digest({ approvalsPending: 1 }) })).toBe(true);
  expect(catchUpHasNews({ ...quiet, turnsCompleted: 1, digest: digest() })).toBe(true);
});
