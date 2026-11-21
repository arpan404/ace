import { parentPort } from "node:worker_threads";

// A forbidden package, loaded at idle in a worker.
await import("@modelcontextprotocol/client");
parentPort?.postMessage("ready");
setInterval(() => {}, 1000);
