import { appendFileSync, readFileSync } from "node:fs";
import { threadId } from "node:worker_threads";

/**
 * Records, in ACE_IDLE_IMPORT_LOG, every provider session and heavy package the daemon loads.
 * Bun's resolve hook never sees package imports, so this watches loads: a hook for exactly the
 * forbidden files logs each one and loads its source as written. Any such load already fails
 * the guard, so how it then loads can't hide a violation. Bun gives worker threads no preload
 * of their parent's: ace's workers take this one through ACE_BENCH_WORKER_PRELOAD (startWorker
 * in @ace/provider-kit/worker), and each isolate it runs in is listed in ACE_IDLE_IMPORT_ISOLATES
 * so the guard can tell a watched worker from an unwatched one.
 */
const forbidden = [
  "sharp",
  "@cursor/sdk",
  "playwright",
  "playwright-core",
  "puppeteer",
  "puppeteer-core",
  "chrome-remote-interface",
  "@anthropic-ai/claude-agent-sdk",
  "@opencode-ai/sdk",
  "@opencode/client",
  "tar",
  "tar-stream",
  "yauzl",
  "@agentclientprotocol/sdk",
  "@modelcontextprotocol/client",
  "@modelcontextprotocol/server",
  "@modelcontextprotocol/node",
];
const sessions = ["claude", "pi", "cursor"].map(
  (provider) => `/packages/adapter-${provider}/src/session.ts`,
);
sessions.push("/packages/adapter-opencode/src/server.ts");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const watched = new RegExp(
  [
    `/node_modules/(?:${forbidden.map(escape).join("|")})/.*\\.[cm]?[jt]s$`,
    ...sessions.map((path) => `${escape(path)}$`),
  ].join("|"),
);
const output = process.env.ACE_IDLE_IMPORT_LOG;
const isolates = process.env.ACE_IDLE_IMPORT_ISOLATES;
if (isolates) appendFileSync(isolates, `${threadId}\n`);

/** What the file is: the session sources are TypeScript, the packages JavaScript. */
const loaderOf = (path: string) => (/\.[cm]?ts$/.test(path) ? "ts" : "js");

/** The part of Bun's plugin builder this hook uses. */
interface LoadHooks {
  onLoad(
    options: { filter: RegExp },
    load: (args: { path: string }) => { contents: string; loader: "ts" | "js" },
  ): void;
}
const bun: unknown = Reflect.get(globalThis, "Bun");
const plugin: unknown = typeof bun === "object" && bun ? Reflect.get(bun, "plugin") : undefined;
if (typeof plugin !== "function") throw new Error("The idle import guard runs on Bun");

if (output)
  Reflect.apply(plugin, bun, [
    {
      name: "idle-imports",
      setup(build: LoadHooks) {
        build.onLoad({ filter: watched }, ({ path }) => {
          const session = sessions.find((file) => path.endsWith(file));
          const name = forbidden.find((each) => path.includes(`/node_modules/${each}/`));
          appendFileSync(output, `${session ?? name}: ${path}\n`);
          return { contents: readFileSync(path, "utf8"), loader: loaderOf(path) };
        });
      },
    },
  ]);
