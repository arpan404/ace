import { execFileSync } from "node:child_process";
import { z } from "zod";
import { lockedExitCode } from "./session-exit.ts";

// A locked desktop rejects human Simulator activation. Fail before booting a device;
// this is an unmet benchmark precondition, never a performance pass. `check` reports it
// as a skip (like a loaded host) so a locked machine cannot block every merge.
if (process.platform === "darwin") {
  const registry = execFileSync("ioreg", ["-a", "-n", "Root", "-d1"], {
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  const output = execFileSync("plutil", ["-extract", "IOConsoleUsers", "json", "-o", "-", "-"], {
    input: registry,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 65536,
  });
  const sessions = z
    .array(
      z.object({
        kCGSSessionUserIDKey: z.number().int(),
        kCGSSessionOnConsoleKey: z.boolean(),
        CGSSessionScreenIsLocked: z.boolean().optional(),
      }),
    )
    .parse(JSON.parse(output));
  const uid = process.getuid?.();
  if (
    sessions.some(
      (session) =>
        session.kCGSSessionUserIDKey === uid &&
        session.kCGSSessionOnConsoleKey &&
        session.CGSSessionScreenIsLocked,
    )
  ) {
    console.error(
      "Device perf requires an unlocked desktop: macOS rejects human Simulator activation while locked. No input latency or performance qualification is possible.",
    );
    process.exit(lockedExitCode);
  }
}
