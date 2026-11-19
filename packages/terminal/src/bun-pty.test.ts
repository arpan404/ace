import { expect, it } from "vitest";
import { spawnBunPty, type BunRuntime } from "./bun-pty.ts";

type TerminalCallbacks = Parameters<BunRuntime["spawn"]>[1]["terminal"];

/** Bun at the boundary: the test decides when output, end of output and exit arrive. */
function fakeBun() {
  let callbacks: TerminalCallbacks | undefined;
  let exit: ((code: number) => void) | undefined;
  const runtime: BunRuntime = {
    spawn(_command, options) {
      callbacks = options.terminal;
      return {
        pid: 4242,
        terminal: { write: (data) => data.length, resize: () => {} },
        exited: new Promise<number>((resolve) => (exit = resolve)),
        exitCode: null,
        signalCode: null,
        kill: () => {},
      };
    },
  };
  const terminal = () => {
    if (!callbacks) throw new Error("not spawned");
    return callbacks;
  };
  return {
    runtime,
    output: (text: string) => terminal().data(undefined, new TextEncoder().encode(text)),
    endOutput: () => terminal().exit(undefined),
    exit: (code: number) => exit?.(code),
  };
}

function record(pty: ReturnType<typeof spawnBunPty>) {
  const events: string[] = [];
  pty.onData((bytes) => events.push(`data:${new TextDecoder().decode(bytes as Uint8Array)}`));
  pty.onExit((exit) => events.push(`exit:${JSON.stringify(exit)}`));
  return events;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

it("output that arrives after the shell exits still comes before the exit", async () => {
  const bun = fakeBun();
  const events = record(spawnBunPty(bun.runtime, "/bin/sh", [], {}));
  bun.output("first ");
  bun.exit(4);
  await settle();
  bun.output("last bytes");
  bun.endOutput();
  await settle();
  expect(events).toEqual([
    "data:first ",
    "data:last bytes",
    `exit:${JSON.stringify({ exitCode: 4, signal: 0 })}`,
  ]);
});

it("a background process holding the terminal open delays the exit only by the grace", async () => {
  const bun = fakeBun();
  const events = record(spawnBunPty(bun.runtime, "/bin/sh", [], { outputGraceMs: 30 }));
  bun.exit(0);
  await settle();
  expect(events).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(events).toEqual([`exit:${JSON.stringify({ exitCode: 0, signal: 0 })}`]);
  bun.endOutput();
  await settle();
  expect(events).toHaveLength(1);
});

it("output held before anyone listens keeps only the newest 4 MiB", () => {
  const bun = fakeBun();
  const pty = spawnBunPty(bun.runtime, "/bin/sh", [], {});
  const chunk = "a".repeat(1024 * 1024);
  for (let index = 0; index < 6; index++) bun.output(index === 5 ? `${chunk.slice(4)}LAST` : chunk);
  let held = "";
  pty.onData((bytes) => (held += new TextDecoder().decode(bytes as Uint8Array)));
  expect(held.length).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(held.endsWith("LAST")).toBe(true);
});
