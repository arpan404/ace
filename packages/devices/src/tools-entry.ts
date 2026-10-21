import { randomUUID } from "node:crypto";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { ToolsRequest, type ToolsReply } from "./device-tools-wire.ts";
import { scrcpyServerJar } from "./scrcpy-jar.ts";
import { DeviceError } from "./sdk.ts";
import { installServeSim } from "./serve-sim-install.ts";

/*
 * A standalone Node entry, run as its own process so downloading, checking and unpacking the
 * device tools never runs on the daemon's event loop. It reads one request as JSON from its
 * first argument and writes one reply as JSON to stdout. Never imported by the service.
 */
const request = ToolsRequest.parse(JSON.parse(process.argv[2] ?? "null"));
const failure = (error: unknown): ToolsReply["error"] =>
  error instanceof DeviceError
    ? { code: error.code, message: error.message, hint: error.hint }
    : {
        code: "tool_missing",
        message: error instanceof Error ? error.message : String(error),
        hint: "Check the network and download the device tools again from Devices.",
      };
let reply: ToolsReply;
try {
  const [serveSim, scrcpy] = await Promise.all([
    request.serveSim
      ? installServeSim({
          directory: request.directory,
          node: request.node,
          ...(request.artifacts ? { artifacts: request.artifacts } : {}),
          runtime: { spawn: spawnRawSupervised, id: randomUUID },
          fetch,
          env: process.env,
        })
      : undefined,
    request.scrcpy
      ? scrcpyServerJar({ directory: request.directory, env: process.env, fetch, id: randomUUID })
      : undefined,
  ]);
  reply = { ...(serveSim ? { serveSim } : {}), ...(scrcpy ? { scrcpy } : {}) };
} catch (error) {
  reply = { error: failure(error) };
}
process.stdout.write(`${JSON.stringify(reply)}\n`);
