// Run with node --expose-gc packages/adapter-claude/benchmarks/translator.ts.
// Public translator only. Returned facts are discarded; no model or CLI is started.
import { performance } from "node:perf_hooks";
import { createTranslator } from "../src/index.ts";
import type { Frame } from "@ace/engine-api";

function repeated(count: number): number {
  const translator = createTranslator({ rootKey: "root" });
  const started = performance.now();
  for (let seq = 0; seq < count; seq++)
    translator.translate(
      {
        seq,
        t: seq,
        dir: "recv",
        channel: "sdk",
        data: {
          type: "assistant",
          session_id: "s",
          message: { id: "same", content: [{ type: "text", text: "same message" }] },
        },
      },
      seq,
    );
  return performance.now() - started;
}
function streamed(count: number): number {
  const translator = createTranslator({ rootKey: "root" });
  let seq = 0;
  const frame = (data: unknown): void => {
    const f: Frame = { seq: seq++, t: seq, dir: "recv", channel: "sdk", data };
    translator.translate(f, seq);
  };
  const started = performance.now();
  frame({ type: "stream_event", event: { type: "message_start", message: { id: "stream" } } });
  for (let index = 0; index < count; index++) {
    frame({
      type: "stream_event",
      event: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    });
    frame({
      type: "assistant",
      uuid: `block-${index}`,
      message: { id: "stream", content: [{ type: "text", text: "paragraph" }] },
    });
  }
  return performance.now() - started;
}
function retention(): number {
  const translator = createTranslator({ rootKey: "root" });
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  for (let seq = 0; seq < 4000; seq++) {
    const t = seq * 3;
    translator.translate(
      {
        seq: t,
        t,
        dir: "recv",
        channel: "sdk",
        data: { type: "system", subtype: "init", session_id: "s" },
      },
      t,
    );
    translator.translate(
      {
        seq: t + 1,
        t: t + 1,
        dir: "recv",
        channel: "sdk",
        data: {
          type: "assistant",
          message: {
            id: `m-${seq}`,
            content: [
              { type: "text", text: Buffer.from(`${seq}:` + "x".repeat(8192)).toString("utf8") },
            ],
          },
        },
      },
      t + 1,
    );
    translator.translate(
      {
        seq: t + 2,
        t: t + 2,
        dir: "recv",
        channel: "sdk",
        data: { type: "result", is_error: false },
      },
      t + 2,
    );
  }
  global.gc?.();
  const retained = process.memoryUsage().heapUsed - before;
  // Keep the translator reachable across GC without retaining its returned facts.
  translator.tick(20_000);
  return retained / 1024 / 1024;
}
function childRetention(): number {
  const translator = createTranslator({ rootKey: "root" });
  let seq = 0;
  const send = (data: unknown) => {
    const frame: Frame = { seq: seq++, t: seq, dir: "recv", channel: "sdk", data };
    translator.translate(frame, seq);
  };
  send({ type: "system", subtype: "init", session_id: "s" });
  send({
    type: "system",
    subtype: "task_started",
    task_id: "C",
    tool_use_id: "launch",
    task_type: "local_agent",
  });
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  for (let message = 0; message < 4000; message++)
    send({
      type: "assistant",
      parent_tool_use_id: "launch",
      uuid: `block-${message}`,
      message: {
        id: `message-${message}`,
        content: [
          { type: "text", text: Buffer.from(`${message}:` + "x".repeat(8192)).toString("utf8") },
        ],
        usage: { input_tokens: 11, output_tokens: 7 },
      },
    });
  send({ type: "system", subtype: "task_updated", task_id: "C", patch: { status: "completed" } });
  send({ type: "result", is_error: false });
  global.gc?.();
  const retained = process.memoryUsage().heapUsed - before;
  translator.tick(20_000);
  return retained / 1024 / 1024;
}
const median = (run: () => number): number =>
  [run(), run(), run()].toSorted((a, b) => a - b)[1] ?? 0;
repeated(2000);
streamed(1000);
console.log(
  JSON.stringify(
    {
      node: process.version,
      repeatedMs: [5000, 10000, 20000].map((n) => ({ frames: n, ms: median(() => repeated(n)) })),
      streamedMs: [5000, 10000, 20000].map((n) => ({ blocks: n, ms: median(() => streamed(n)) })),
      retainedMiB: retention(),
      retainedChildMiB: childRetention(),
    },
    null,
    2,
  ),
);
