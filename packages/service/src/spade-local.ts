import { homedir } from "node:os";
import { currentUserSid } from "./windows-user.ts";
import { spadeServicePlan, type SpadePlatform, type SpadeServicePlan } from "./spade-plan.ts";

/**
 * Spade's service plan for `home` on this machine, for this account. The OS lookups live here,
 * in the I/O shell; `spadeServicePlan` itself stays pure.
 */
export async function localSpadePlan(home: string): Promise<SpadeServicePlan> {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32")
    throw new Error(`Spade's service is not available on ${platform}`);
  const target: SpadePlatform = platform;
  return spadeServicePlan(home, target, {
    userHome: homedir(),
    uid: process.getuid?.() ?? 0,
    ...(target === "win32"
      ? { sid: await currentUserSid(), systemRoot: process.env.SystemRoot ?? "C:\\Windows" }
      : {}),
  });
}
