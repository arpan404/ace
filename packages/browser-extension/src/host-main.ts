import { WebSocket } from "ws";
import { extensionOrigin } from "./extension-id.ts";
import { readDaemonEndpoint, readHostCredential } from "./host-files.ts";
import { relayNativeHost } from "./host-relay.ts";

/**
 * The native messaging host Chrome starts for ace for Chrome (ADR 0084). Chrome passes the
 * calling extension's origin; the launcher adds `--data-dir`. Logs go to stderr, which Chrome
 * keeps out of the message stream.
 */
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
