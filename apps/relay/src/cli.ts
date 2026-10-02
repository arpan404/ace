import { startRelay } from "./server.ts";
import { defaultLimits } from "./limits.ts";
import type { Limits } from "./limits.ts";
const limits: Partial<Limits> = {};
for (const key of Object.keys(defaultLimits) as (keyof Limits)[]) {
  const envKey = "ACE_RELAY_" + key.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase();
  if (process.env[envKey] !== undefined) limits[key] = Number(process.env[envKey]);
}
const port = Number(process.env["ACE_RELAY_PORT"] ?? 8787);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid ACE_RELAY_PORT");
const relay = await startRelay({ port, bind: process.env["ACE_RELAY_BIND"] ?? "0.0.0.0", limits });
console.log(`ace relay listening on port ${relay.port}`);
let closing = false;
const shutdown = () => {
  if (!closing) {
    closing = true;
    void relay.close().catch(() => {
      process.exitCode = 1;
    });
  }
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
