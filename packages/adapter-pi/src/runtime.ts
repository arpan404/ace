import { randomBytes, randomUUID } from "node:crypto";
import { discoverPi } from "@ace/provider-kit/discovery";
import { spawnTextSupervised } from "@ace/provider-kit/process";
import type { Schedule } from "./rpc.ts";
export type PiRuntime = {
  processKey: () => string;
  now: () => number;
  secret: () => string;
  schedule: Schedule;
  spawn: typeof spawnTextSupervised;
  discover: typeof discoverPi;
  /** Host platform; tests inject "win32" to cover the Windows stop path. */
  platform?: NodeJS.Platform;
};
export const runtime: PiRuntime = {
  processKey: randomUUID,
  now: () => performance.now(),
  secret: () => randomBytes(32).toString("hex"),
  spawn: spawnTextSupervised,
  discover: discoverPi,
  schedule(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};
