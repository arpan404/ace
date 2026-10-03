import { createServer } from "node:net";
import { resolve } from "node:path";
import { PreviewLaunch, type PreviewLaunch as Launch } from "@ace/protocol/preview";
import {
  spawnSupervised,
  type SupervisedProcess,
  type SpawnOptions,
} from "@ace/provider-kit/process";
import { loopbackUrl } from "./terminal-urls.ts";

async function reservePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No reserved preview port");
  return {
    port: address.port,
    release: () =>
      new Promise<void>((done, reject) => server.close((e) => (e ? reject(e) : done()))),
  };
}
export type LaunchHandle = {
  name: string;
  url: string | undefined;
  process: SupervisedProcess | undefined;
  stop: () => Promise<void>;
};
export function createLaunchManager(options: {
  root: string;
  env?: NodeJS.ProcessEnv;
  spawn?: (options: SpawnOptions) => SupervisedProcess;
  onOutput?: (name: string, line: string) => void;
}) {
  const active = new Map<string, LaunchHandle>();
  const starting = new Map<string, Promise<void>>();
  let closed = false;
  const stopEntry = async (entry: LaunchHandle) => {
    await entry.process?.stop();
    if (active.get(entry.name) === entry) active.delete(entry.name);
  };
  const stop = async (name: string) => {
    await starting.get(name);
    const entry = active.get(name);
    if (entry) await stopEntry(entry);
  };
  return {
    async start(input: Launch): Promise<LaunchHandle> {
      const entry = PreviewLaunch.parse(input);
      if (closed) throw new Error("Launch manager closed");
      if (active.has(entry.name) || starting.has(entry.name))
        throw new Error("Launch already active");
      if (active.size + starting.size >= 64) throw new Error("Too many launches");
      let finished: (() => void) | undefined;
      starting.set(
        entry.name,
        new Promise<void>((done) => {
          finished = done;
        }),
      );
      let reserved: Awaited<ReturnType<typeof reservePort>> | undefined;
      try {
        if (entry.url) {
          const url = loopbackUrl(entry.url);
          if (url.protocol !== "http:") throw new Error("Launch attach requires HTTP");
          const handle: LaunchHandle = {
            name: entry.name,
            url: url.href,
            process: undefined,
            stop: () => stopEntry(handle),
          };
          active.set(entry.name, handle);
          return handle;
        }
        if (entry.autoPort) reserved = await reservePort();
        if (closed) throw new Error("Launch manager closed");
        const port = reserved?.port ?? entry.port;
        await reserved?.release();
        reserved = undefined;
        if (closed) throw new Error("Launch manager closed");
        const command = entry.command ?? entry.runtimeExecutable;
        if (!command) throw new Error("Missing launch executable");
        const proc = (options.spawn ?? spawnSupervised)({
          command,
          args: entry.args,
          cwd: resolve(options.root, entry.cwd ?? "."),
          env: {
            ...options.env,
            ...entry.env,
            ...(port === undefined ? {} : { PORT: String(port) }),
          },
          name: `preview:${entry.name}`,
          maxLineBytes: 65_536,
        });
        const handle: LaunchHandle = {
          name: entry.name,
          url: port === undefined ? undefined : `http://localhost:${port}/`,
          process: proc,
          stop: () => stopEntry(handle),
        };
        active.set(entry.name, handle);
        if (options.onOutput) {
          const emit = options.onOutput;
          proc.stdout.on("line", (line: string) => emit(entry.name, line.slice(0, 8192)));
          proc.stderr.on("line", (line: string) => emit(entry.name, line.slice(0, 8192)));
        }
        void proc.exited.then(() => {
          if (active.get(entry.name) === handle) active.delete(entry.name);
        });
        return handle;
      } finally {
        try {
          await reserved?.release();
        } finally {
          starting.delete(entry.name);
          finished?.();
        }
      }
    },
    stop,
    list: () => [...active.values()].map((entry) => ({ name: entry.name, url: entry.url })),
    async close() {
      closed = true;
      await Promise.all(starting.values());
      await Promise.all([...active.keys()].map(stop));
    },
  };
}
