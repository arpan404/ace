// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { parentPort } from "node:worker_threads";
import { nodeMatches } from "./node-matches.ts";
import { workerRequest } from "./worker-messages.ts";
parentPort?.on("message", (raw: unknown) => {
  try {
    const request = workerRequest.parse(raw);
    parentPort?.postMessage({ type: "started" });
    const matches = nodeMatches(request);
    parentPort?.postMessage({ matches });
  } catch (error) {
    parentPort?.postMessage({ error: String(error) });
  }
});
