// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { parentPort } from "node:worker_threads";
import { runPosixOperation } from "./posix-native.ts";
import { PosixRequest, type PosixReply } from "./posix-wire.ts";

// Requests run one at a time, in order: a reader's reads follow its open.
parentPort?.on("message", (raw: unknown) => {
  const request = PosixRequest.safeParse(raw);
  if (!request.success) return;
  const { id, operation } = request.data;
  let reply: PosixReply;
  try {
    reply = { id, ok: true, value: runPosixOperation(operation) };
  } catch (error) {
    reply = {
      id,
      ok: false,
      message: error instanceof Error ? error.message : "Native call failed",
    };
  }
  parentPort?.postMessage(reply);
});
