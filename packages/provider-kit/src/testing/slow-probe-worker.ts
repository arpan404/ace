// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { parentPort } from "node:worker_threads";
import { ProbeRequest } from "../probe-messages.ts";

// Stands in for a spawn that blocks its thread for 400 ms, as posix_spawn did under heavy load.
parentPort?.on("message", (input: unknown) => {
  const request = ProbeRequest.safeParse(input);
  if (!request.success) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  parentPort?.postMessage({
    type: "exit",
    id: request.data.id,
    code: 0,
    signal: null,
    reason: "exit",
    stdout: "slow\n",
    stderr: "",
  });
});
