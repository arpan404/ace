import { ThreadId } from "@ace/protocol";
import { createAcpAdapter } from "../index.ts";

const collect = global.gc;
if (!collect) throw new Error("Retention diagnostic requires --expose-gc");
const translator = createAcpAdapter().createTranslator({
  threadId: ThreadId.parse("retention"),
  rootKey: "root",
});
let seq = 0;
const completed = new Set<string>();
let emittedChunks = 0,
  lastCommand = "",
  lastOutputPrefix = "",
  lastOutputTail = "",
  failedTools = 0,
  completedTurns = 0,
  diagnosticErrors = 0;
function feed(data: unknown, dir: "recv" | "send" = "recv") {
  const facts = translator.translate({ seq: ++seq, t: seq, dir, channel: "stdio", data }, seq);
  for (const fact of facts) {
    if (fact.type === "item.upsert" && fact.draft.type === "tool_call" && fact.draft.complete) {
      completed.add(fact.item);
      if (fact.draft.call?.status === "failed") failedTools++;
      if (fact.draft.call?.detail?.kind === "shell")
        lastCommand = fact.draft.call.detail.command ?? "";
    } else if (fact.type === "item.delta" && fact.field === "output") {
      emittedChunks++;
      lastOutputPrefix = fact.append.slice(0, 3);
      lastOutputTail = fact.append.slice(-8);
    } else if (fact.type === "turn.ended" && fact.outcome === "completed") completedTurns++;
  }
  return translator.takeDiagnostics?.() ?? [];
}
feed({ id: 1, method: "session/new", params: { cwd: "/workspace" } }, "send");
feed({ id: 1, result: { sessionId: "native" } });
feed(
  {
    id: 2,
    method: "session/prompt",
    params: { sessionId: "native", prompt: [{ type: "text", text: "build" }] },
  },
  "send",
);
const lateErrors = process.argv[2] === "late-errors";
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
              status: lateErrors ? "failed" : "completed",
              rawInput: { command: `build-${index}` },
              rawOutput: lateErrors
                ? { error: "initial failure" }
                : { stdout: String(index) + "x".repeat(64 * 1024) },
            },
          },
        }),
      ),
    );
}
batch(0, lateErrors ? 1000 : 100);
collect();
const before = process.memoryUsage().heapUsed;
if (lateErrors) {
  for (let index = 0; index < 1000; index++) {
    const error = `${index}:` + "x".repeat(500 * 1024);
    const diagnostics = feed(
      JSON.parse(
        JSON.stringify({
          method: "session/update",
          params: {
            sessionId: "native",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: `shell-${index}`,
              rawOutput: { error },
            },
          },
        }),
      ),
    );
    if (JSON.stringify(diagnostics).includes(error)) diagnosticErrors++;
  }
} else batch(100, 800);
collect();
const retainedBytes = process.memoryUsage().heapUsed - before;
feed({ id: 2, result: { stopReason: "end_turn" } });
process.stdout.write(
  JSON.stringify({
    retainedBytes,
    completedTools: completed.size,
    emittedChunks,
    lastCommand,
    lastOutputPrefix,
    lastOutputTail,
    failedTools,
    completedTurns,
    diagnosticErrors,
  }),
);
