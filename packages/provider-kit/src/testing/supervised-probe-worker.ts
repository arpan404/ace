// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { parentPort } from "node:worker_threads";
import { createProbeRunner, supervisedProbe } from "../probe-runner.ts";

// The probe worker as it was before Bun.spawn: every probe a node:child_process supervised spawn.
const port = parentPort;
if (!port) throw new Error("The probe worker runs only as a worker thread");
const runner = createProbeRunner((message) => port.postMessage(message), supervisedProbe());
port.on("message", (input: unknown) => runner.handle(input));
