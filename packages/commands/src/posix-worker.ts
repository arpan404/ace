// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { parentPort } from "node:worker_threads";
import { PosixThread } from "./posix-thread.ts";
import { PosixDrain, PosixRequest, type PosixReply } from "./posix-wire.ts";

// Requests run one at a time, in order: a reader's reads follow its open.
const thread = new PosixThread();
parentPort?.on("message", (raw: unknown) => {
  if (PosixDrain.safeParse(raw).success) {
    // Everything this thread owns, late results of an abandoned call included, closes here.
    thread.release();
    parentPort?.close();
    return;
  }
  const request = PosixRequest.safeParse(raw);
  if (!request.success) return;
  const { id, operation } = request.data;
  let reply: PosixReply;
  try {
    reply = { id, ok: true, value: thread.run(operation) };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    reply = {
      id,
      ok: false,
      message: error instanceof Error ? error.message : "Native call failed",
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  parentPort?.postMessage(reply);
});
