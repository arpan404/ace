import { homedir } from "node:os";
import { silenceConsole } from "@ace/provider-kit/console-guard";
import { validateCursorAuthHome } from "./auth-home.ts";
import { discoverCursorSdk } from "./host.ts";
import { saveCursorApiKey } from "./api-key.ts";

// No SDK diagnostics may escape a credential worker, including during import or failure. The
// daemon also fails the save once output passes its budget. Bun's console skips the write
// patches, so it is silenced on its own, before the SDK is imported below.
process.stdout.write = () => true;
process.stderr.write = () => true;
silenceConsole();
process.on("uncaughtException", () => process.exit(1));
process.on("unhandledRejection", () => process.exit(1));
const key = Buffer.alloc(8193);
let used = 0;
try {
  await validateCursorAuthHome(homedir());
  if (!(await discoverCursorSdk()).supported) throw new Error("Unsupported SDK");
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk) || used + chunk.length > key.length)
      throw new Error("Invalid key input");
    key.set(chunk, used);
    used += chunk.length;
    chunk.fill(0);
  }
  const sdk = await import("@cursor/sdk");
  await saveCursorApiKey(key.subarray(0, used), {
    sdk,
    backendUrl: process.env.CURSOR_BACKEND_URL ?? "https://api2.cursor.sh",
    now: Date.now,
  });
} catch {
  process.exitCode = 1;
} finally {
  key.fill(0);
}
