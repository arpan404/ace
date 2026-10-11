import { ThreadId } from "@ace/protocol";
import { createAcpAdapter } from "../index.ts";
import { z } from "zod";

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
  diagnosticPayloads = 0;
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
const mode = z
  .enum(["output", "late-errors", "late-title", "late-kind"])
  .parse(process.argv[2] ?? "output");
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
              status: mode === "late-errors" ? "failed" : "completed",
              rawInput: { command: `build-${index}` },
              rawOutput:
                mode === "late-errors"
                  ? { error: "initial failure" }
                  : { stdout: String(index) + "x".repeat(64 * 1024) },
            },
          },
        }),
      ),
    );
}
batch(0, mode === "output" ? 100 : 1000);
collect();
const before = process.memoryUsage().heapUsed;
if (mode !== "output") {
  for (let index = 0; index < 1000; index++) {
    const payload = `${index}:` + "x".repeat(500 * 1024);
    const diagnostics = feed(
      JSON.parse(
        JSON.stringify({
          method: "session/update",
          params: {
            sessionId: "native",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: `shell-${index}`,
              ...(mode === "late-errors"
                ? { rawOutput: { error: payload } }
                : { [mode === "late-title" ? "title" : "kind"]: { opaque: payload } }),
            },
          },
        }),
      ),
    );
    if (JSON.stringify(diagnostics).includes(payload)) diagnosticPayloads++;
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
    diagnosticPayloads,
  }),
);
