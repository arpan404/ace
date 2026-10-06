import { execFileSync } from "node:child_process";
import { z } from "zod";

// A locked desktop rejects human Simulator activation. Fail before booting a device;
// this is an unmet benchmark precondition, never a performance pass or a skip.
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
  )
    throw new Error(
      "Device perf requires an unlocked desktop: macOS rejects human Simulator activation while locked. No input latency or performance qualification is possible.",
    );
}
