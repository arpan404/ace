// Pure production task settlement benchmark. Execution deferred to merge.
import { CursorTranslator } from "../src/index.ts";
import { ThreadId } from "@ace/protocol";
const batches = 100,
  children = 200;
let seq = 0,
  facts = 0;
const start = performance.now();
for (let batch = 0; batch < batches; batch++) {
  const translator = new CursorTranslator({ threadId: ThreadId.parse("bench"), rootKey: "root" });
  const frame = (kind: string, body: unknown) => {
    facts += translator.translate(
      {
        seq: ++seq,
        t: seq,
        dir: "recv",
        channel: "sdk",
        data: {
          schemaVersion: 1,
          generation: "host",
          operationId: "operation",
          segment: 0,
          kind,
          body,
        },
      },
      seq,
    ).length;
  };
  frame("open", { cwd: "/bench" });
  frame("send", { input: [] });
  for (let i = 0; i < children; i++) {
    frame("delta", {
      type: "tool-call-started",
      callId: `task-${i}`,
      toolCall: { type: "task", args: {} },
    });
    frame("delta", {
      type: "tool-call-delta",
      callId: `task-${i}`,
      taskUpdate: {
        type: "tool-call-started",
        callId: `shell-${i}`,
        toolCall: { type: "shell", args: { command: "synthetic" } },
      },
    });
  }
  for (let i = 0; i < children; i++)
    frame("delta", {
      type: "tool-call-completed",
      callId: `task-${i}`,
      toolCall: { type: "task", result: { status: "success", value: {} } },
    });
  frame("result", { status: "finished" });
}
const elapsed = performance.now() - start,
  count = batches * children;
console.log(
  JSON.stringify({
    path: "sdk-child-terminal-owner-preservation",
    opsPerSecond: (count * 1000) / elapsed,
    microsPerOp: (elapsed * 1000) / count,
    facts,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);
