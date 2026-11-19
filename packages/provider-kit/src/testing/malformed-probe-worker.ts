// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { parentPort } from "node:worker_threads";
import { ProbeRequest } from "../probe-messages.ts";

// Answers with an exit that breaks the reply format, as Bun's undefined signal once did.
parentPort?.on("message", (input: unknown) => {
  const request = ProbeRequest.safeParse(input);
  if (!request.success) return;
  parentPort?.postMessage({ type: "exit", id: request.data.id, code: null, reason: "spawn-error" });
});
