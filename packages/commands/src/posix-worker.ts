// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { parentPort } from "node:worker_threads";
import { releasePosixState, runPosixOperation } from "./posix-native.ts";
import { PosixDrain, PosixRequest, type PosixOperation, type PosixReply } from "./posix-wire.ts";

// Requests run one at a time, in order: a reader's reads follow its open.
let last: { id: number; operation: PosixOperation; value: number | string | null } | undefined;
parentPort?.on("message", (raw: unknown) => {
  const drain = PosixDrain.safeParse(raw);
  if (drain.success) {
    // Everything this thread still owns closes here, on the thread that opened it.
    const abandoned = last && last.id === drain.data.abandoned ? last : undefined;
    releasePosixState(abandoned);
    parentPort?.close();
    return;
  }
  const request = PosixRequest.safeParse(raw);
  if (!request.success) return;
  const { id, operation } = request.data;
  let reply: PosixReply;
  try {
    const value = runPosixOperation(operation);
    last = { id, operation, value };
    reply = { id, ok: true, value };
  } catch (error) {
    last = undefined;
    reply = {
      id,
      ok: false,
      message: error instanceof Error ? error.message : "Native call failed",
    };
  }
  parentPort?.postMessage(reply);
});
