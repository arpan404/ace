import { channel } from "node:diagnostics_channel";
import { appendFileSync, readFileSync } from "node:fs";
import { isMainThread, threadId, Worker } from "node:worker_threads";

/**
 * Records, in ACE_IDLE_IMPORT_LOG, every provider session and heavy package the daemon loads.
 * Bun's resolve hook never sees package imports, so this watches loads: a hook for exactly the
 * forbidden files logs each one and loads its source as written. Any such load already fails
 * the guard, so how it then loads can't hide a violation. Bun gives worker threads no preload
 * of their parent's: ace's workers take this one through ACE_BENCH_WORKER_PRELOAD (startWorker
 * in @ace/provider-kit/worker). ACE_IDLE_IMPORT_ISOLATES records, by worker id, each worker
 * the factory announced, each isolate the hook ran in, and at shutdown the next worker id, so
 * the guard can name any worker that ran unwatched (worker-coverage.ts).
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
if (isolates) {
  const record = (line: string) => appendFileSync(isolates, `${line}\n`);
  record(`ack ${threadId}`);
  // Held for the process's life: Bun drops a channel nothing references.
  const created = channel("worker_threads");
  Reflect.set(globalThis, "aceIdleImportWorkerChannel", created);
  created.subscribe((message) => {
    const worker: unknown = Reflect.get(Object(message), "worker");
    if (worker instanceof Worker) record(`start ${worker.threadId}`);
  });
  // The guard's close request: the id the next worker gets bounds every id that ran. Listening
  // from the preload, this runs before the daemon's own handler exits.
  if (isMainThread)
    process.on("message", (request: unknown) => {
      if (Reflect.get(Object(request), "op") !== "close") return;
      const probe = new Worker("", { eval: true });
      record(`next ${probe.threadId}`);
      void probe.terminate();
    });
}

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
