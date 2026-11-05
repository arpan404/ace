// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { writeFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { ProbeRequest } from "../probe-messages.ts";
import { createProbeRunner } from "../probe-runner.ts";

// Runs real probes but announces each spawn without its pid, a reply the main thread can't read.
// The real pid goes to the file the request's ACE_PROBE_PID_FILE names, for the test to check.
let pidFile: string | undefined;
const runner = createProbeRunner((message) => {
  if (message.type === "spawned") {
    if (pidFile) writeFileSync(pidFile, String(message.pid));
    parentPort?.postMessage({ type: "spawned", id: message.id });
    return;
  }
  parentPort?.postMessage(message);
});
parentPort?.on("message", (input: unknown) => {
  const request = ProbeRequest.safeParse(input);
  if (request.success) pidFile = request.data.env["ACE_PROBE_PID_FILE"];
  runner.handle(input);
});
