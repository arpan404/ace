import { facts, type FakeDaemon } from "@ace/fake-daemon";

/*
 * A working thread that receives tool calls in bursts, as a provider does when it runs many
 * reads and commands back to back: each burst starts `size` tools, streams some output into
 * them, finishes them and says a few lines, every fact applied on its own a few milliseconds apart. Used to check
 * that the transcript takes a burst without flickering. No provider process runs.
 */

export const toolBurstThread = "ios-burst";

export function seedToolBurst(
  daemon: FakeDaemon,
  details: (branch: string) => Record<string, unknown>,
): void {
  daemon.createThread({
    hasSentMessage: true,
    id: toolBurstThread,
    workspaceId: "ace",
    title: "Tool burst",
    provider: "codex",
    details: details("feat/tool-burst"),
  });
  daemon.apply(toolBurstThread, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "burst-ask", "user", "Read the relay and run its tests."),
  ]);
}

/** One burst, spread over `spreadMs` by the pace function the fixture passes in. */
export function toolBurst(
  daemon: FakeDaemon,
  burst: number,
  size: number,
  pace: (run: () => void, ms: number) => void,
  spreadMs = 300,
): void {
  const steps: (() => void)[] = [];
  const apply = (fact: Parameters<FakeDaemon["apply"]>[1][number]) =>
    steps.push(() => daemon.apply(toolBurstThread, [fact]));
  for (let n = 0; n < size; n++) {
    const id = `burst-${burst}-${n}`;
    if (n % 3 === 0)
      apply(
        facts.tool("root", id, {
          kind: "shell",
          title: `Run step ${n} tests`,
          detail: { kind: "shell", command: `bun run test relay/step-${n}.test.ts` },
        }),
      );
    else
      apply(
        facts.tool("root", id, {
          kind: "file.read",
          title: `Read relay/step-${n}.ts`,
          detail: { kind: "file.read", path: `relay/step-${n}.ts` },
        }),
      );
  }
  for (let n = 0; n < size; n += 3)
    apply(facts.output("root", `burst-${burst}-${n}`, `relay/step-${n}.test.ts ✓ 3 passed\n`));
  for (let n = 0; n < size; n++) apply(facts.toolDone("root", `burst-${burst}-${n}`));
  // What the agent says after each burst starts a block of its own, so the thread keeps growing
  // and its oldest rows leave the live window's top while the reader follows the end.
  apply(
    facts.message(
      "root",
      `burst-${burst}-note`,
      "assistant",
      `Burst ${burst}: ${size} steps passed.\n\n- The relay keeps each cursor.\n- Replay reads it back after a reconnect.\n- Nothing was killed that the daemon didn't start.`,
    ),
  );
  steps.forEach((step, at) => pace(step, Math.round((at / steps.length) * spreadMs)));
}
