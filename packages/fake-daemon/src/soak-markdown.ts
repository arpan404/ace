/*
 * A long agent answer in markdown, for streaming budgets: numbered sections of prose with
 * inline formatting, nested and task lists, a fenced code block, a table and a quote, repeated
 * until the answer reaches the size asked for. Deterministic, so runs compare.
 */

function section(n: number): string {
  const window = 200 + n * 8;
  const rows = Array.from(
    { length: 6 },
    (_, row) =>
      `| relay-${n}-${row} | ${window + row * 4} | ${(12 + ((n * 7 + row * 3) % 40)).toFixed(1)} | ${row % 3 === 0 ? "yes" : "no"} |`,
  ).join("\n");
  return `## ${n}. Replay window for shard ${n}

The relay keeps a bounded replay window per shard. This step covers **what changed**, why the \`lastAckedSeq\` cursor matters, and how [the resume handshake](https://ace.dev/docs/relay#resume) behaves when a client reconnects in the middle of a stream. Frames older than the window are *never* replayed; the client gets a fresh snapshot instead.

- Cap the window at ${window} events
  - drop frames the client already acknowledged
  - keep \`seq\` monotonic across restarts
- Persist the cursor before acknowledging
- [x] replay tests pass for shard ${n}
- [ ] soak shard ${n} for a week

\`\`\`ts
export function replay(window: readonly Frame[], acked: number): Frame[] {
  // Shard ${n}: everything after the acknowledged sequence, capped.
  const start = window.findIndex((frame) => frame.seq > acked);
  if (start < 0) return [];
  const frames = window.slice(start, start + ${window});
  for (const frame of frames) {
    if (frame.seq <= acked) throw new Error(\`stale frame \${frame.seq}\`);
  }
  return frames;
}
\`\`\`

| shard | window | p95 (ms) | dropped |
| --- | ---: | ---: | --- |
${rows}

> A reconnect that arrives with a cursor older than shard ${n}'s window gets a snapshot, not a
> replay, so the client never applies a frame twice.

1. Ship the cap for shard ${n}
2. Watch the replay dashboards for a day
3. Remove the old unbounded path

`;
}

/** An answer of at least `chars` characters (40,000 by default). */
export function longMarkdownAnswer(chars = 40_000): string {
  let text =
    "Here is what changed in the relay, shard by shard, with the code and the numbers.\n\n";
  for (let n = 1; text.length < chars; n++) text += section(n);
  return `${text}That covers every shard.\n`;
}
