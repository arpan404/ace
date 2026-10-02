// Public-API performance regression probe. Diagnostic only; never part of the test gate.
// node packages/adapter-claude/benchmarks/pending-edges.ts [--verify-scaling]
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createTranslator } from "../src/index.ts";

function deltas(pending: number): number {
  const translator = createTranslator({ rootKey: "root" });
  let seq = 0;
  const send = (data: unknown, t: number) =>
    translator.translate({ seq: seq++, t, dir: "recv", channel: "sdk", data }, t);
  send({ type: "system", subtype: "init", session_id: "s" }, 0);
  send(
    {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: Array.from({ length: pending }, (_, index) => ({
        task_id: `task-${index}`,
        task_type: "local_bash",
        ambient: true,
      })),
    },
    10,
  );
  send({ type: "system", subtype: "background_tasks_changed", tasks: [] }, 100);
  send({ type: "stream_event", event: { type: "message_start", message: { id: "stream" } } }, 199);
  send(
    {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    199,
  );
  const started = performance.now();
  for (let index = 0; index < 5000; index++)
    send(
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
      },
      200,
    );
  return performance.now() - started;
}
const median = (pending: number): number =>
  [deltas(pending), deltas(pending), deltas(pending)].toSorted((a, b) => a - b)[1] ?? 0;
deltas(0);
const results = [0, 2000, 10000].map((pending) => ({ pending, ms: median(pending) }));
console.log(JSON.stringify({ node: process.version, results }, null, 2));
if (process.argv.includes("--verify-scaling")) {
  const baseline = results[0]?.ms ?? 1;
  const loaded = results[2]?.ms ?? 0;
  assert(loaded / baseline < 8, "unchanged pending edges must not multiply delta translation cost");
}
