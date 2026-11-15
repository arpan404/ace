/**
 * head-of-line.ts with the client's end of the relay timed too: each `commandResult` line the
 * client's relay route reads (decrypted, before the client handles it) is recorded with when it
 * arrived, so a relay-path receipt's
 * wait splits into the link (to the client's channel) and the client (after it). A load hook, as
 * head-of-line-daemon.ts uses for the daemon's end; nothing in the product changes.
 *
 *   bun apps/daemon/bench/head-of-line-traced.ts [head-of-line.ts flags]
 */
import { readFileSync } from "node:fs";

interface LoadHooks {
  onLoad(
    options: { filter: RegExp },
    load: (args: { path: string }) => { contents: string; loader: "ts" },
  ): void;
}
type Plugin = (plugin: { name: string; setup(build: LoadHooks): void }) => void;
const isPlugin = (value: unknown): value is Plugin => typeof value === "function";

/** commandId → when the client's channel decrypted its result, on the epoch clock. */
const arrivals = new Map<string, number>();
Reflect.set(globalThis, "__aceHeadOfLineClientArrivals", arrivals);
Reflect.set(globalThis, "__aceHeadOfLineClientRelay", (text: string) => {
  for (const line of text.split("\n")) {
    if (!line.includes('"type":"commandResult"')) continue;
    const commandId = /"commandId":"([^"]+)"/.exec(line)?.[1];
    if (commandId && !arrivals.has(commandId))
      arrivals.set(commandId, performance.timeOrigin + performance.now());
  }
});

const bun: unknown = Reflect.get(globalThis, "Bun");
const plugin: unknown =
  typeof bun === "object" && bun !== null ? Reflect.get(bun, "plugin") : undefined;
if (!isPlugin(plugin)) throw new Error("head-of-line-traced.ts runs on Bun");
plugin.call(bun, {
  name: "head-of-line-client-relay",
  setup(build) {
    build.onLoad({ filter: /packages\/client\/src\/relay-route\.ts$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      const from = "const frame = await opened.receiveRaw();";
      if (!source.includes(from)) throw new Error(`The client's relay route no longer has: ${from}`);
      const contents = source.replace(
        from,
        `${from} if (typeof frame === "string") globalThis.__aceHeadOfLineClientRelay?.(frame);`,
      );
      return { contents, loader: "ts" };
    });
  },
});
await import("./head-of-line.ts");
