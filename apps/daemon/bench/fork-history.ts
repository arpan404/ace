// What making a fork of a long thread costs: the copy of the source's conversation runs inside
// the fork's write transaction. A source of 1,000 asks and answers among 4,000 tool steps, some
// answers far over the copy's text budget. Never contacts an installed provider CLI.
import type { Fact } from "@ace/core";
import { maxInheritedMessages } from "../src/engine/fork-history.ts";
import { transitionHarness } from "../src/engine/transition-test-support.ts";

const exchanges = 500;
const toolsPerExchange = 8;
const long = "z".repeat(200_000);
const h = transitionHarness();
try {
  const source = await h.create();
  for (let turn = 0; turn < exchanges; turn++) {
    const facts: Fact[] = [
      { type: "turn.started", agent: "root", nativeTurnId: `bench-${turn}`, trigger: "user" },
      {
        type: "item.upsert",
        agent: "root",
        item: `ask-${turn}`,
        draft: {
          type: "message",
          role: "user",
          complete: true,
          parts: [{ type: "text", text: `Question ${turn}` }],
        },
      },
    ];
    for (let tool = 0; tool < toolsPerExchange; tool++)
      facts.push({
        type: "item.upsert",
        agent: "root",
        item: `tool-${turn}-${tool}`,
        draft: {
          type: "tool_call",
          complete: true,
          call: {
            kind: "shell",
            title: `ls ${tool}`,
            status: "succeeded",
            detail: { kind: "shell", command: `ls ${tool}` },
          },
        },
      });
    facts.push(
      {
        type: "item.upsert",
        agent: "root",
        item: `answer-${turn}`,
        draft: {
          type: "message",
          role: "assistant",
          complete: true,
          parts: [{ type: "text", text: turn % 50 === 0 ? long : `Answer ${turn}` }],
        },
      },
      { type: "turn.ended", agent: "root", nativeTurnId: `bench-${turn}`, outcome: "completed" },
    );
    h.emit(source, ...facts);
    if (turn % 25 === 24) await h.engine.flush();
  }
  await h.engine.flush();
  const newest = Object.values(h.store.snapshotThread(source).runs).find(
    (run) => run.nativeId === `bench-${exchanges - 1}` && run.endedAt !== undefined,
  );
  if (!newest) throw new Error("No finished run");
  const point = { type: "turn" as const, runId: newest.id };
  const samples: number[] = [];
  let copies = 0;
  for (let round = 0; round < 5; round++) {
    const start = performance.now();
    const result = h.command({
      type: "thread.fork",
      threadId: source,
      point,
      input: "continue",
      budgetBytes: 16384,
    });
    samples.push(performance.now() - start);
    if (!result.ok || !result.forkThreadId) throw new Error(result.error ?? "Fork failed");
    copies = h.store.historicalItemCount(result.forkThreadId, h.store.headSeq());
    await h.engine.flush();
  }
  samples.sort((a, b) => a - b);
  process.stdout.write(
    JSON.stringify({
      sourceItems: exchanges * (toolsPerExchange + 2),
      copiedAtMost: maxInheritedMessages,
      forkItems: copies,
      medianForkMs: samples[Math.floor(samples.length / 2)],
      maxForkMs: samples.at(-1),
    }) + "\n",
  );
} finally {
  await h.close();
}
