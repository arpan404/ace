/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker_threads has no targetOrigin. */
import { parentPort } from "node:worker_threads";
let count = 0;
parentPort.on("message", (input) => parentPort.postMessage({ input, count: ++count }));
