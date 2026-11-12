import { heapStats } from "bun:jsc";
import { runInThisContext } from "node:vm";
import { createNodeHost } from "@ace/native-host/node";

/**
 * How much JavaScriptCore heap the phone's shared client costs before it does anything: builds
 * the bridge as `bun run bundle` does (in memory, nothing written), installs a host the way
 * Swift installs `aceHost`, evaluates the bundle and reports what stays after full collections.
 * Bun runs JavaScriptCore, so this is a fair proxy for the app's context at launch:
 *
 *   bun scripts/bundle-heap.ts
 */
const bridge = new URL("../bridge/main.ts", import.meta.url).pathname;
const built = await Bun.build({
  entrypoints: [bridge],
  target: "browser",
  format: "iife",
  minify: true,
});
const output = built.outputs[0];
if (!built.success || !output) throw new AggregateError(built.logs, "The bridge didn't build");
const source = await output.text();

Object.assign(globalThis, {
  aceHost: createNodeHost({
    now: () => 0,
    uuid: () => "00000000-0000-4000-8000-000000000000",
    random: () => 0.5,
  }),
});
const settle = () => {
  for (let pass = 0; pass < 6; pass++) Bun.gc(true);
};
settle();
const before = heapStats();
const started = performance.now();
// The bundle is a script, evaluated in this global scope as the app evaluates it in its context.
runInThisContext(source);
const evaluated = performance.now() - started;
settle();
const after = heapStats();
const grew = (name: string) =>
  (after.objectTypeCounts[name] ?? 0) - (before.objectTypeCounts[name] ?? 0);
const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);
console.log(`bundle             ${mb(source.length)} MB`);
console.log(`retained heap      ${mb(after.heapSize - before.heapSize)} MB`);
console.log(`objects            ${after.objectCount - before.objectCount}`);
console.log(`functions          ${grew("Function")}`);
console.log(`evaluation         ${evaluated.toFixed(0)} ms`);
