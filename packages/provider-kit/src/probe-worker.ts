// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { parentPort } from "node:worker_threads";
import { createProbeRunner } from "./probe-runner.ts";

/*
 * Runs bounded CLI probes for the main thread. `spawn` blocks its calling thread until the child
 * has started, which under heavy load took seconds; here that wait holds only this isolate. The
 * main thread owns each process as soon as it hears the pid, and still stops it on exit.
 */
const port = parentPort;
if (!port) throw new Error("The probe worker runs only as a worker thread");
const runner = createProbeRunner((message) => port.postMessage(message));
port.on("message", (input: unknown) => runner.handle(input));
