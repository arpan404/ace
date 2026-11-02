import { createHash } from "node:crypto";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";

/*
 * A long, finished conversation for reading back with an accessibility client attached: many
 * turns of a person's message, shell steps and a Markdown answer (a heading, a list with inline
 * code, a code block), ending in a turn a restart interrupted. Every tenth turn publishes an HTML
 * chart, so reading back crosses inline pages that must keep their height. No provider process
 * runs.
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

/** Turns that publish a chart, and the chart page each one publishes. */
const charted = (n: number) => n % 10 === 4;
const chart = (n: number) => {
  const bars = Array.from(
    { length: 8 },
    (_, i) =>
      `<div style="display:flex;gap:8px;align-items:center"><span style="width:56px">run ${i + 1}</span><div style="height:18px;width:${20 + ((n * 7 + i * 13) % 70)}%;background:#4f8cff;border-radius:4px"></div></div>`,
  ).join("");
  return `<!doctype html><html><head><title>Reconnect timings ${n + 1}</title></head><body style="font:14px system-ui;margin:0;padding:12px"><h2 style="margin:0 0 12px">Reconnect timings, step ${n + 1}</h2><div style="display:grid;gap:10px">${bars}</div><p>Median resume after a drop: ${120 + n} ms.</p></body></html>`;
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

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
    ...(charted(n) ? [published(n)] : []),
    facts.endTurn("root", n === turns - 1 ? "interrupted" : "completed"),
  ];
}

function published(n: number): Fact {
  const html = chart(n);
  return {
    type: "item.upsert",
    agent: "root",
    item: `chart-${n}`,
    draft: {
      type: "html",
      complete: true,
      visualization: {
        title: `Reconnect timings ${n + 1}`,
        mode: "static",
        document: {
          sha256: sha(html),
          bytes: Buffer.byteLength(html),
          mimeType: "text/plain",
          name: `timings-${n + 1}.html`,
        },
      },
    },
  };
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
  const pages = Array.from({ length: turns }, (_, n) => n).filter(charted);
  daemon.seedServices({
    attachmentTexts: pages.map((n) => ({
      threadId: "ios-reading",
      sha256: sha(chart(n)),
      text: chart(n),
      name: `timings-${n + 1}.html`,
    })),
  });
}
