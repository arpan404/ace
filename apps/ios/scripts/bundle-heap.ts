import { heapStats } from "bun:jsc";
import { createContext, runInContext } from "node:vm";
import { createNodeHost } from "@ace/native-host/node";

/**
 * How much JavaScriptCore heap the phone's shared client costs before it does anything: builds
 * the bridge as `bun run bundle` does (in memory, nothing written) and evaluates it as a script
 * in a fresh global context holding only `aceHost`, as `ClientRuntime` evaluates it in a bare
 * JSContext. That context has the language's built-ins but none of Bun's web APIs, so the bundle
 * installs and keeps its own TextEncoder, URL and cancellation polyfills, as it does on the
 * phone. Reports what stays after full collections. Bun runs JavaScriptCore, so this stands in
 * for the app at launch (the one difference: Bun's contexts also carry a `console`):
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

const aceHost = createNodeHost({
  now: () => 0,
  uuid: () => "00000000-0000-4000-8000-000000000000",
  random: () => 0.5,
});
const settle = () => {
  for (let pass = 0; pass < 6; pass++) Bun.gc(true);
};
// The empty context's own built-ins are the engine's, not the bundle's: made before measuring.
const phone = createContext({ aceHost });
settle();
const before = heapStats();
const started = performance.now();
runInContext(source, phone);
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
const polyfilled = ["TextEncoder", "URL", "AbortController"].filter(
  (name) => runInContext(`typeof ${name}`, phone) === "function",
);
console.log(`polyfills kept     ${polyfilled.join(", ") || "none"}`);
