import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";

/*
 * A thread of message rows for the spike daemon, matching what the web's demo threads show: a
 * steered, long bubble with code, a thought with its time, a Markdown answer (headings, a list,
 * a table, inline code, a long code block, a link), a repeated failure, a compaction and a
 * provider handoff. Facts are dated in the past. No provider process runs.
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

| Case | Before | After |
| --- | --- | --- |
| Restart | Reset to 5 | Kept |
| Clean exit | Reset to 5 | Reset to 5 |

\`\`\`ts
${code}
\`\`\`

See [ADR 0065](https://example.com/adr-0065) for the delivery rules.`;

const failure = (item: string): Fact =>
  upsert(item, {
    type: "notice",
    level: "error",
    complete: true,
    text: "The model stopped responding.",
    raw: [],
  });

export function seedMessages(daemon: FakeDaemon, details: Details): void {
  daemon.createThread(
    {
      hasSentMessage: true,
      id: "ios-messages",
      workspaceId: "ace",
      title: "Keep the retry budget across restarts",
      provider: "codex",
      details: details("fix/retry-budget"),
    },
    20 * minute,
  );
  daemon.apply("ios-messages", [facts.rootAgent("codex"), facts.turn("root")], 18 * minute);
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
  daemon.apply(
    "ios-messages",
    [
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
}
