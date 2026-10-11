import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";

// Drive the actual watcher through build and process boundaries, without starting Electron.
async function watcher() {
  vi.useFakeTimers();
  const children: Child[] = [];
  class Child extends EventEmitter {
    exitCode: number | null = null;
    signalCode: string | null = null;
    signals: string[] = [];
    kill(signal: string) {
      this.signals.push(signal);
      if (signal === "SIGKILL") this.exit();
    }
    exit() {
      this.exitCode = 0;
      this.emit("exit", 0);
    }
  }
  const ends: ((result: { errors: unknown[] }) => void)[] = [];
  const process = new EventEmitter();
  const exits: number[] = [];
  const ports = {
    spawn: () => {
      const child = new Child();
      children.push(child);
      return child;
    },
    context: async (options: {
      plugins: {
        setup(build: { onEnd(cb: (result: { errors: unknown[] }) => void): void }): void;
      }[];
    }) => {
      for (const plugin of options.plugins) plugin.setup({ onEnd: (cb) => ends.push(cb) });
      return { watch: async () => {}, dispose: async () => {} };
    },
    process: Object.assign(process, { env: {}, exit: (code: number) => exits.push(code) }),
  };
  const entry = new URL("../scripts/dev.ts", import.meta.url);
  const result = await build({
    entryPoints: [entry.pathname],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    define: { process: "ports.process" },
    plugins: [
      {
        name: "machine-boundaries",
        setup(builder) {
          builder.onResolve(
            { filter: /^(node:child_process|esbuild|\.\/common\.ts)$/ },
            (args) => ({ path: args.path, namespace: "fixture" }),
          );
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            contents:
              args.path === "esbuild"
                ? "export const context = ports.context;"
                : args.path === "node:child_process"
                  ? "export const spawn = ports.spawn;"
                  : 'export const desktop="/tmp/ace"; export const mainEntry="main.cjs"; export const appEnvironment=e=>e; export const electronBinary=async()=>"electron"; export const electronBundles=()=>[{},{}];',
          }));
          // Inline platform imports so the resulting script runs in the controlled machine.
          builder.onResolve({ filter: /^node:path$/ }, () => ({
            path: "path",
            namespace: "fixture-path",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture-path" }, () => ({
            contents: 'export const join=(...parts)=>parts.join("/");',
          }));
        },
      },
    ],
  });
  const code = result.outputFiles[0]?.text;
  if (!code) throw new Error("No watcher bundle");
  await runInNewContext(`(async () => { ${code.replace(/^#![^\n]*\n/, "")} })()`, {
    ports,
    setTimeout,
    clearTimeout,
    console,
  });
  for (const end of ends) end({ errors: [] });
  return {
    children,
    exits,
    rebuild: () => ends[0]?.({ errors: [] }),
    stop: () => process.emit("SIGTERM"),
  };
}
afterEach(() => vi.useRealTimers());

it("coalesces rebuilds during a slow Electron exit and shuts down its replacement", async () => {
  const w = await watcher();
  w.rebuild();
  await vi.advanceTimersByTimeAsync(150);
  w.rebuild();
  await vi.advanceTimersByTimeAsync(150);
  expect(w.children.filter((child) => child.exitCode === null)).toHaveLength(1);
  w.children[0]?.exit();
  await vi.advanceTimersByTimeAsync(0);
  expect(w.children).toHaveLength(2);
  w.stop();
  await vi.advanceTimersByTimeAsync(0);
  w.children[1]?.exit();
  await vi.advanceTimersByTimeAsync(0);
  expect(w.children.every((child) => child.exitCode !== null)).toBe(true);
  expect(w.exits).toEqual([0]);
});

it("quits during a restart even if Electron ignores graceful termination", async () => {
  const w = await watcher();
  w.rebuild();
  await vi.advanceTimersByTimeAsync(150);
  w.stop();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(w.children.filter((child) => child.exitCode === null)).toHaveLength(0);
  expect(w.exits).toEqual([0]);
});
