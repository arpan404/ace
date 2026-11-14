import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";

/*
 * Threads of message rows for the spike daemon, matching what the web's demo threads show: a
 * steered, long bubble with code, a thought with its time, a Markdown answer (headings, a list,
 * inline code, a long code block, a link), a repeated failure, a compaction, a
 * provider handoff, a brief another thread's agent sent and a message typed with exact spacing. Facts are dated in the past. No
 * provider process runs.
 */

type Details = (branch: string) => Record<string, unknown>;
const minute = 60_000;

const upsert = (item: string, draft: Record<string, unknown>): Fact =>
  ({ type: "item.upsert", agent: "root", item, draft }) as Fact;

const longAsk = [
  "The retry budget resets on every app-server restart. Here's what I see:",
  "```ts",
  "const budget = new RetryBudget({ max: 5 });",
  'server.on("restart", () => budget.reset());',
  "```",
  ...Array.from({ length: 12 }, (_, i) => `- Restart ${i + 1} put the budget back to five.`),
  "Keep the budget across restarts and add a test.",
].join("\n");

const code = Array.from({ length: 26 }, (_, i) =>
  i === 0
    ? "export class RetryBudget {"
    : i === 25
      ? "}"
      : `  step${i}(): void { this.spent += ${i}; }`,
).join("\n");

const answer = `## What changed

The budget now lives in the daemon's \`retry-state.json\`, so a restart reads it back.

1. \`RetryBudget\` loads its spent count on start.
2. A restart no longer calls \`reset()\`.
3. The test restarts the server three times.

See [ADR 0065](https://example.com/adr-0065) for the delivery rules.`;

const codeAnswer = `Here is the class as it stands:

\`\`\`ts
${code}
\`\`\``;

const failure = (item: string): Fact =>
  upsert(item, {
    type: "notice",
    level: "error",
    complete: true,
    text: "The model stopped responding.",
    raw: [],
  });

const brief = [
  "Add a restart test for the retry budget.",
  "Start the app server, spend two retries, then restart it.",
  "Check the budget still reads three left.",
  "Restart twice more and check it again.",
  "Keep the test under a second: use the fake clock.",
  "Report back with the test's name.",
  // Longer than an event row carries, so Copy must hold all of what the bubble shows.
  ...Array.from({ length: 120 }, (_, i) => `Note ${i + 1}: keep the budget across restarts.`),
].join("\n");

/** Typed with a markdown hard break, spaces inside fenced code and blank lines: Copy keeps them. */
const typed = "First line  \nsecond line\n\n\n```sh\necho hi   \n  indented\n```\n\n- one\n- two";

function thread(
  daemon: FakeDaemon,
  details: Details,
  id: string,
  title: string,
  startedBy?: string,
): void {
  daemon.createThread(
    {
      hasSentMessage: true,
      id,
      workspaceId: "ace",
      title,
      provider: "codex",
      details: details("fix/retry-budget"),
      ...(startedBy ? { startedBy } : {}),
    },
    20 * minute,
  );
  daemon.apply(id, [facts.rootAgent("codex"), facts.turn("root")], 18 * minute);
}

/**
 * Five short threads, each one screen tall: the bubble and answer, a long code block, events, a
 * brief another thread sent, and a message whose spacing Copy must keep.
 */
export function seedMessages(daemon: FakeDaemon, details: Details): void {
  thread(daemon, details, "ios-messages", "Keep the retry budget across restarts");
  daemon.apply(
    "ios-messages",
    [
      upsert("ask", {
        type: "message",
        role: "user",
        complete: true,
        origin: { kind: "steer" },
        parts: [{ type: "text", text: longAsk }],
      }),
      upsert("think", {
        type: "reasoning",
        complete: true,
        text: "The budget is in memory. **Persist it** next to the server state.",
      }),
    ],
    17 * minute,
  );
  daemon.apply(
    "ios-messages",
    [facts.message("root", "answer", "assistant", answer), facts.endTurn("root")],
    16 * minute + 48_000,
  );

  thread(daemon, details, "ios-code", "Show the retry budget class");
  daemon.apply(
    "ios-code",
    [
      facts.message("root", "ask", "user", "Show me `RetryBudget` as it is now."),
      facts.message("root", "answer", "assistant", codeAnswer),
      facts.endTurn("root"),
    ],
    15 * minute,
  );

  thread(daemon, details, "ios-events", "Verify the retry budget after a handoff");
  daemon.apply(
    "ios-events",
    [
      facts.message("root", "first", "user", "Persist the retry budget."),
      facts.message("root", "done", "assistant", "Persisted in `retry-state.json`."),
      facts.endTurn("root"),
      upsert("compacted", { type: "compaction", complete: true }),
      upsert("handoff", {
        type: "message",
        role: "user",
        complete: true,
        synthetic: true,
        origin: {
          kind: "handoff",
          from: { provider: "claude", model: "opus-4.1" },
          to: { provider: "codex", model: "gpt-5.5" },
          lossy: true,
        },
        parts: [
          {
            type: "text",
            text: JSON.stringify({ summary: "Retry budget persisted. Verify on a restart." }),
          },
        ],
      }),
      facts.turn("root"),
      facts.message("root", "verify", "user", "Run it once more after a restart."),
      failure("fail-1"),
      failure("fail-2"),
      facts.endTurn("root", "failed"),
    ],
    10 * minute,
  );

  // A conversation the retry-budget thread's agent started: its brief names that thread.
  thread(daemon, details, "ios-sent", "Test the retry budget across restarts", "ios-messages");
  daemon.apply(
    "ios-sent",
    [
      upsert("brief", {
        type: "message",
        role: "user",
        complete: true,
        synthetic: true,
        origin: {
          kind: "parent_agent",
          parentThreadId: "ios-messages",
          from: { provider: "claude" },
        },
        parts: [{ type: "text", text: brief }],
      }),
      facts.message("root", "ack", "assistant", "On it: a restart test with the fake clock."),
      facts.endTurn("root"),
    ],
    9 * minute,
  );

  thread(daemon, details, "ios-copy", "Copy a message as typed");
  daemon.apply(
    "ios-copy",
    [
      facts.message("root", "ask", "user", typed),
      facts.message("root", "ack", "assistant", "Noted."),
      facts.endTurn("root"),
    ],
    8 * minute,
  );
}
