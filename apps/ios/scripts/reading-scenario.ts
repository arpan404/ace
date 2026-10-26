import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";

/*
 * A long, finished conversation for reading back with an accessibility client attached: many
 * turns of a person's message, shell steps and a Markdown answer (a heading, a list with inline
 * code, a code block), ending in a turn a restart interrupted. No provider process runs.
 */

type Details = (branch: string) => Record<string, unknown>;
const minute = 60_000;
const turns = 120;

const answer = (n: number) => `## Step ${n + 1}

The relay now keeps \`cursor-${n}\` across reconnects, so a phone that drops and comes back reads
from where it stopped instead of the start.

- \`relay.ts\` stores the cursor with the lease.
- \`replay.ts\` resumes from it after a restart.
- The test reconnects three times and checks the order.

\`\`\`ts
const cursor = await leases.cursor("thread-${n}");
for await (const event of relay.since(cursor)) send(event);
\`\`\`

Checks pass: \`bun run typecheck\` and the relay tests.`;

function turn(n: number): Fact[] {
  const shell = (step: string, command: string): Fact[] => [
    facts.tool("root", `${step}-${n}`, {
      kind: "shell",
      title: command,
      detail: { kind: "shell", command },
    }),
    facts.toolDone("root", `${step}-${n}`),
  ];
  return [
    facts.turn("root"),
    facts.message("root", `ask-${n}`, "user", `Keep the relay cursor for step ${n + 1} too.`),
    ...shell("read", `rg -n cursor relay/step-${n}.ts`),
    ...shell("test", `bunx vitest run relay/step-${n}.test.ts`),
    facts.message("root", `answer-${n}`, "assistant", answer(n)),
    facts.endTurn("root", n === turns - 1 ? "interrupted" : "completed"),
  ];
}

export function seedReading(daemon: FakeDaemon, details: Details): void {
  daemon.createThread(
    {
      hasSentMessage: true,
      id: "ios-reading",
      workspaceId: "ace",
      title: "Keep relay cursors across reconnects",
      provider: "claude",
      details: details("fix/relay-cursor"),
    },
    (turns + 10) * minute,
  );
  daemon.apply("ios-reading", [facts.rootAgent("claude")], (turns + 9) * minute);
  for (let n = 0; n < turns; n++) daemon.apply("ios-reading", turn(n), (turns - n) * minute);
}
