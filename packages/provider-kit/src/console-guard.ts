import { Console } from "node:console";
import { Writable } from "node:stream";

/*
 * Guards for child processes whose stdout is a protocol channel. Under Bun, `console` writes
 * straight to fds 1 and 2, past any patch of `process.stdout.write` or `process.stderr.write`,
 * so a dependency's log line lands in the protocol stream. A `Console` built on a stream object
 * calls that object's `write` each time, so it honours such patches, made before or after.
 * Call a guard before importing third-party code, which may log while it loads.
 */
const methods = [
  "log",
  "error",
  "warn",
  "info",
  "debug",
  "dir",
  "dirxml",
  "table",
  "trace",
  "group",
  "groupCollapsed",
  "groupEnd",
  "count",
  "countReset",
  "time",
  "timeEnd",
  "timeLog",
  "assert",
] as const;

function replaceConsole(sink: Console): void {
  for (const method of methods) Object.assign(console, { [method]: sink[method].bind(sink) });
}

/** Every console method writes to `process.stderr`, through whatever patch its `write` has. */
export function routeConsoleToStderr(): void {
  replaceConsole(new Console({ stdout: process.stderr, stderr: process.stderr }));
}

/** Every console method discards its output, for a worker nothing may escape from. */
export function silenceConsole(): void {
  const discard = new Writable({ write: (_chunk, _encoding, done) => done() });
  replaceConsole(new Console({ stdout: discard, stderr: discard }));
}
