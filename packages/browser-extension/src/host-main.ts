import { routeConsoleToStderr } from "@ace/provider-kit/console-guard";

/**
 * The native messaging host Chrome starts for ace for Chrome (ADR 0084). Chrome passes the
 * calling extension's origin; the launcher adds `--data-dir`. Logs go to stderr, which Chrome
 * keeps out of the message stream. Stdout carries only length-prefixed frames, and Bun's console
 * writes there directly, so console goes to stderr before any dependency loads: static imports
 * would evaluate ahead of this call, so everything else is imported after it.
 */
routeConsoleToStderr();
const { WebSocket } = await import("ws");
const { extensionOrigin } = await import("./extension-id.ts");
const { readDaemonEndpoint, readHostCredential } = await import("./host-files.ts");
const { relayNativeHost } = await import("./host-relay.ts");
const args = process.argv.slice(2);
const dataDirIndex = args.indexOf("--data-dir");
const dataDir = dataDirIndex === -1 ? undefined : args[dataDirIndex + 1];
const origin = args.find((arg) => arg.startsWith("chrome-extension://"));
const log = (message: string) => process.stderr.write(`ace native host: ${message}\n`);
if (!dataDir) {
  log("missing --data-dir");
  process.exit(2);
}
if (origin !== undefined && origin !== extensionOrigin) {
  log(`refusing caller ${origin}`);
  process.exit(3);
}
await relayNativeHost({
  input: process.stdin,
  output: process.stdout,
  endpoint: () => readDaemonEndpoint(dataDir),
  credential: () => readHostCredential(dataDir),
  open: (url) => new WebSocket(url),
  delay: (milliseconds, work) => {
    const timer = setTimeout(work, milliseconds);
    return () => clearTimeout(timer);
  },
  log,
});
process.exit(0);
