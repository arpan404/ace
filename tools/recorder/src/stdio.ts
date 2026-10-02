import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import type { SupervisedProcess } from "@ace/provider-kit/process";
import type { Recording } from "./recording.ts";

/** Recorder channels stay at this boundary; provider-kit has no logging policy. */
export function createRecordedPeer(proc: SupervisedProcess, rec: Recording): JsonRpcPeer {
  proc.stderr.on("line", (line) => rec.frame("stderr", "stdio", line, false));
  void proc.exited.then(({ code, signal }) => rec.note("process-exit", { code, signal }));
  return new JsonRpcPeer(proc, {
    // Session prompts and approvals can remain pending indefinitely.
    timeoutMs: null,
    onFrame: (direction, message) => rec.frame(direction, "stdio", message),
    onMalformed: (line) => rec.frame("recv", "stdio-text", line),
  });
}
