import { facts, type FakeDaemon } from "@ace/fake-daemon";

/*
 * A working thread whose turn reads like real agent output: a thought streamed in, a group of
 * reads and commands with output, then a long answer streamed a few words at a time, with a
 * heading, a list and a code block taller than the screen. Each round adds tall rows of very
 * different heights, as real work does, so the feed's estimate of what is above keeps changing
 * while it follows the end. No provider process runs.
 */

export const richWorkThread = "ios-rich";

export function seedRichWork(
  daemon: FakeDaemon,
  details: (branch: string) => Record<string, unknown>,
): void {
  daemon.createThread({
    hasSentMessage: true,
    id: richWorkThread,
    workspaceId: "ace",
    title: "Rework the relay replay",
    provider: "claude",
    details: details("feat/relay-replay"),
  });
  daemon.apply(richWorkThread, [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message(
      "root",
      "rich-ask",
      "user",
      "Rework replay so a reconnect resumes from the lease.",
    ),
  ]);
}

const code = (round: number) =>
  Array.from(
    { length: 48 },
    (_, line) =>
      `  const cursor${line} = lease.read(${round}, ${line}); // resume where the last client stopped`,
  ).join("\n");

const answer = (round: number) =>
  [
    `### Round ${round}: replay resumes from the lease`,
    "",
    "The relay now writes the cursor with the lease, so a reconnect picks up where it stopped:",
    "",
    "- `relay.ts` stores the cursor beside the lease.",
    "- `replay.ts` reads it back and skips what the client already has.",
    "- A restart keeps both, so nothing replays twice.",
    "",
    "```ts",
    `export function resume${round}(lease: Lease) {`,
    code(round),
    "}",
    "```",
    "",
    "Next I run the relay tests again with the new cursor.",
  ].join("\n");

/**
 * One round of work, spread over `spreadMs` by `pace`: a thought, ten tools, then the answer
 * streamed in small pieces.
 */
export function richRound(
  daemon: FakeDaemon,
  round: number,
  pace: (run: () => void, ms: number) => void,
  spreadMs = 4000,
): void {
  const steps: (() => void)[] = [];
  const apply = (fact: Parameters<FakeDaemon["apply"]>[1][number]) =>
    steps.push(() => daemon.apply(richWorkThread, [fact]));
  const thought = `rich-${round}-thought`;
  const thinking = `Round ${round} needs the cursor written with the lease. `.repeat(6).split(". ");
  apply({
    type: "item.upsert",
    agent: "root",
    item: thought,
    draft: { type: "reasoning", complete: false, text: "" },
  });
  for (const part of thinking)
    apply({ type: "item.delta", agent: "root", item: thought, field: "text", append: `${part}. ` });
  apply({
    type: "item.upsert",
    agent: "root",
    item: thought,
    draft: { type: "reasoning", complete: true },
  });
  for (let n = 0; n < 10; n++) {
    const id = `rich-${round}-tool-${n}`;
    apply(
      n % 2
        ? facts.tool("root", id, {
            kind: "shell",
            title: `Run relay step ${n} tests`,
            detail: { kind: "shell", command: `bun run test relay/step-${n}.test.ts` },
          })
        : facts.tool("root", id, {
            kind: "file.read",
            title: `Read relay/step-${n}.ts`,
            detail: { kind: "file.read", path: `relay/step-${n}.ts` },
          }),
    );
    if (n % 2) apply(facts.output("root", id, `relay/step-${n}.test.ts ✓ 12 passed\n`.repeat(6)));
    apply(facts.toolDone("root", id));
  }
  const reply = `rich-${round}-answer`;
  const words = answer(round).split(/(?<=\s)/);
  apply(facts.message("root", reply, "assistant", "", false));
  for (let at = 0; at < words.length; at += 6)
    apply(facts.stream("root", reply, words.slice(at, at + 6).join("")));
  apply(facts.finish("root", reply));
  steps.forEach((step, at) => pace(step, Math.round((at / steps.length) * spreadMs)));
}
