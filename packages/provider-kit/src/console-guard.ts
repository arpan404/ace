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

const standard = new Set<string>(methods);

function replaceConsole(stream: NodeJS.WritableStream): void {
  const sink = new Console({ stdout: stream, stderr: stream });
  for (const method of methods) Object.assign(console, { [method]: sink[method].bind(sink) });
  // Bun adds console functions of its own: `write` prints its arguments and `takeHeapSnapshot`
  // prints the snapshot, both to fd 1. `write` goes to the stream; every other extra (and any a
  // later runtime adds) does nothing, since none has a place in a protocol child.
  for (const key of Object.getOwnPropertyNames(console)) {
    if (key === "Console" || standard.has(key) || typeof Reflect.get(console, key) !== "function")
      continue;
    Object.assign(console, { [key]: key === "write" ? writeTo(stream) : () => {} });
  }
}

function writeTo(stream: NodeJS.WritableStream) {
  return (...data: unknown[]): number => {
    let bytes = 0;
    for (const item of data) {
      const chunk = ArrayBuffer.isView(item)
        ? new Uint8Array(item.buffer, item.byteOffset, item.byteLength)
        : String(item);
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      stream.write(chunk);
    }
    return bytes;
  };
}

/** Every console method writes to `process.stderr`, through whatever patch its `write` has. */
export function routeConsoleToStderr(): void {
  replaceConsole(process.stderr);
}

/** Every console method discards its output, for a worker nothing may escape from. */
export function silenceConsole(): void {
  replaceConsole(new Writable({ write: (_chunk, _encoding, done) => done() }));
}
