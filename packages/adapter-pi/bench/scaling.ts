/** Non-gating serialization/output scaling. Unexecuted; needs run at merge. */
import { performance } from "node:perf_hooks";
import { ThreadId } from "@ace/protocol";
import { createPiTranslator } from "../src/index.ts";
export function runScalingBenchmark() {
  const threadId = ThreadId.parse("pi-scaling");
  for (const blocks of [16, 32, 64, 128, 256]) {
    const translator = createPiTranslator({ threadId, rootKey: "root" });
    const data = {
      type: "message_end",
      future: "f".repeat(512 * 1024),
      message: {
        role: "assistant",
        content: Array.from({ length: blocks }, () => ({ type: "text", text: "a" })),
        stopReason: "stop",
      },
    };
    let serializedBytes = 0;
    const count = 200,
      start = performance.now();
    for (let i = 0; i < count; i++) {
      const facts = translator.translate({ seq: i, t: i, dir: "recv", channel: "stdio", data }, i);
      // Include the raw serialization paid by persistence, rather than timing references only.
      for (const fact of facts)
        if (fact.type === "item.upsert")
          serializedBytes += Buffer.byteLength(JSON.stringify(fact.draft));
    }
    console.log(
      JSON.stringify({
        path: "final message and raw serialization",
        blocks,
        opsPerSecond: (count / (performance.now() - start)) * 1000,
        serializedBytesPerFrame: serializedBytes / count,
        peakRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  }
  for (const prefixBytes of [1024, 16 * 1024, 256 * 1024]) {
    const translator = createPiTranslator({ threadId, rootKey: "root" });
    translator.translate(
      {
        seq: 0,
        t: 0,
        dir: "recv",
        channel: "stdio",
        data: { type: "tool_execution_start", toolCallId: "shell", toolName: "bash", args: {} },
      },
      0,
    );
    const growing = { type: "text", text: "" };
    const content = [
      { type: "text", text: "a".repeat(prefixBytes / 2) },
      { type: "text", text: "b".repeat(prefixBytes / 2) },
      growing,
    ];
    const data = { type: "tool_execution_update", toolCallId: "shell", partialResult: { content } };
    const count = 10_000,
      start = performance.now();
    let emittedBytes = 0;
    for (let i = 0; i < count; i++) {
      growing.text += "x";
      for (const fact of translator.translate(
        { seq: i + 1, t: i, dir: "recv", channel: "stdio", data },
        i,
      ))
        if (fact.type === "item.delta") emittedBytes += Buffer.byteLength(fact.append);
    }
    console.log(
      JSON.stringify({
        path: "multi-block cumulative output",
        prefixBytes,
        opsPerSecond: (count / (performance.now() - start)) * 1000,
        emittedBytes,
        peakRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  }
}
