import { ThreadId } from "@ace/protocol";
import { createAcpAdapter } from "../index.ts";

const collect = global.gc;
if (!collect) throw new Error("Retention diagnostic requires --expose-gc");
const translator = createAcpAdapter().createTranslator({
  threadId: ThreadId.parse("retention"),
  rootKey: "root",
});
let seq = 0;
function feed(data: unknown, dir: "recv" | "send" = "recv") {
  translator.translate({ seq: ++seq, t: seq, dir, channel: "stdio", data }, seq);
  translator.takeDiagnostics?.();
}
feed({ id: 1, method: "session/new", params: { cwd: "/workspace" } }, "send");
feed({ id: 1, result: { sessionId: "native" } });
function batch(start: number, count: number) {
  for (let index = start; index < start + count; index++)
    feed(
      JSON.parse(
        JSON.stringify({
          method: "session/update",
          params: {
            sessionId: "native",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `shell-${index}`,
              kind: "execute",
              status: "completed",
              rawInput: { command: `build-${index}` },
              rawOutput: { stdout: String(index) + "x".repeat(64 * 1024) },
            },
          },
        }),
      ),
    );
}
batch(0, 100);
collect();
const before = process.memoryUsage().heapUsed;
batch(100, 800);
collect();
process.stdout.write(JSON.stringify({ retainedBytes: process.memoryUsage().heapUsed - before }));
