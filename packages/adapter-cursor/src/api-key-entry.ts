import { silenceConsole } from "@ace/provider-kit/console-guard";

// No SDK diagnostics may escape a credential worker, including during import or failure. The
// daemon also fails the save once output passes its budget. Bun's console skips the write
// patches, so it is silenced on its own. Static imports would evaluate ahead of this, so every
// other module is imported after it, inside the try: a failing import exits quietly instead of
// reaching the runtime's fatal reporter, which writes to fd 2 past the patches.
process.stdout.write = () => true;
process.stderr.write = () => true;
silenceConsole();
process.on("uncaughtException", () => process.exit(1));
process.on("unhandledRejection", () => process.exit(1));
const key = Buffer.alloc(8193);
let used = 0;
try {
  const { homedir } = await import("node:os");
  const { validateCursorAuthHome } = await import("./auth-home.ts");
  const { discoverCursorSdk } = await import("./host.ts");
  const { saveCursorApiKey } = await import("./api-key.ts");
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
