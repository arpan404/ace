/** Non-gating. Do not execute until merge under the owner's current rule. */
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { ThreadId } from "@ace/protocol";
import { readJsonLines } from "@ace/provider-kit/jsonl";
import { createPiTranslator } from "../src/index.ts";
import { runScalingBenchmark } from "./scaling.ts";
const count = 1_000_000;
const translator = createPiTranslator({ threadId: ThreadId.parse("bench"), rootKey: "root" });
translator.translate(
  { seq: 0, t: 0, dir: "recv", channel: "stdio", data: { type: "agent_start" } },
  0,
);
const frame = {
  seq: 1,
  t: 1,
  dir: "recv" as const,
  channel: "stdio",
  data: {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" },
  },
};
let started = performance.now();
for (let i = 0; i < count; i++) {
  frame.seq = i + 1;
  translator.translate(frame, i);
}
console.log(
  JSON.stringify({
    path: "translate text delta",
    opsPerSecond: (count / (performance.now() - started)) * 1000,
    peakRssKiB: process.resourceUsage().maxRSS,
  }),
);
const input = new PassThrough();
let records = 0;
const detach = readJsonLines(
  input,
  1024 * 1024,
  () => records++,
  (error) => {
    throw error;
  },
);
const bytes = Buffer.from('{"type":"delta","text":"hello\u2028world"}\n');
started = performance.now();
for (let i = 0; i < count; i++) input.write(bytes);
input.end();
detach();
console.log(
  JSON.stringify({
    path: "LF framing",
    opsPerSecond: (records / (performance.now() - started)) * 1000,
    peakRssKiB: process.resourceUsage().maxRSS,
  }),
);

runScalingBenchmark();
