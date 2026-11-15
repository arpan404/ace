/**
 * head-of-line.ts's bench daemon: slow-link-daemon.ts with the relay channel's synchronous
 * deflates timed. A load hook gives `apps/relay/src/channel.ts` head-of-line-zlib.ts in place of
 * `node:zlib` (Bun binds a builtin's named imports when it links, so patching `node:zlib`
 * itself would not reach it). Nothing in the product changes; only this process loads the hook.
 */
import { readFileSync } from "node:fs";

/** The part of Bun's plugin API this needs. */
interface LoadHooks {
  onLoad(
    options: { filter: RegExp },
    load: (args: { path: string }) => { contents: string; loader: "ts" },
  ): void;
}
type Plugin = (plugin: { name: string; setup(build: LoadHooks): void }) => void;
const isPlugin = (value: unknown): value is Plugin => typeof value === "function";

const zlib = new URL("./head-of-line-zlib.ts", import.meta.url).pathname;
const bun: unknown = Reflect.get(globalThis, "Bun");
const plugin: unknown =
  typeof bun === "object" && bun !== null ? Reflect.get(bun, "plugin") : undefined;
if (!isPlugin(plugin)) throw new Error("head-of-line-daemon.ts runs on Bun");
plugin.call(bun, {
  name: "head-of-line-deflate-probe",
  setup(build) {
    build.onLoad({ filter: /apps\/relay\/src\/channel\.ts$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      const rewritten = source.replace(/from "node:zlib";/, `from ${JSON.stringify(zlib)};`);
      if (rewritten === source) throw new Error("The relay channel no longer imports node:zlib");
      return { contents: rewritten, loader: "ts" };
    });
  },
});
await import("./slow-link-daemon.ts");
