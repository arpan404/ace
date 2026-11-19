import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { assertTestEnvironmentIsolation } from "@ace/provider-kit/test-isolation";
import { WorkspaceId, type BrowserProfileScope, type ThreadId } from "@ace/protocol";
import type { startDaemon } from "../../../daemon/src/index.ts";
import { bunBinary } from "../../../../scripts/runtimes.ts";
import {
  desktopDaemonEnvironment,
  desktopDaemonLayout,
  environmentFolders,
} from "./daemon-environment.ts";
import {
  browserMethods,
  DaemonReply,
  decodeValue,
  marker,
  SpecThread,
  VideoSeen,
  type BrowserMethod,
  type DaemonProfile,
  type DaemonRequest,
} from "./daemon-protocol.ts";

type Browser = Awaited<ReturnType<typeof startDaemon>>["browser"];
/** The daemon's browser service as the specs reach it: each method, answered asynchronously. */
export type RemoteBrowser = {
  [M in BrowserMethod]: Browser[M] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

export interface DesktopDaemon {
  /** The daemon's process. */
  pid: number;
  url: string;
  tokenPath: string;
  browser: RemoteBrowser;
  createWorkspace(path: string, name: string): Promise<WorkspaceId>;
  /** A thread as a client prepares one, listed on Home. */
  prepareThread(workspaceId: WorkspaceId, title: string): Promise<SpecThread>;
  /** A thread written straight to the store, as development builds create one. */
  devThread(workspaceId: WorkspaceId): Promise<SpecThread>;
  setProfileScope(scope: BrowserProfileScope): Promise<void>;
  /**
   * A remote viewer of a page's live video, as a web connection is one, kept in the daemon
   * process: its sink is a callback, which can't cross the pipe.
   */
  watchVideo(options: {
    threadId: ThreadId;
    connectionId: string;
    viewport: { width: number; height: number };
    codecs: string[];
  }): Promise<VideoViewer>;
  close(): Promise<void>;
}

export interface VideoViewer {
  /** The chunks and keyframes it has received so far. */
  seen(): Promise<VideoSeen>;
  stop(): Promise<void>;
}

type Request = DaemonRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;

/**
 * Starts the desktop e2e daemon (daemon-process.ts) on Bun, the daemon's runtime, in its own
 * process: its environment is built here from the root alone, so it sees only the spec's
 * folders, and its stdin is a pipe only this process holds, so it stops when the spec does.
 */
export async function startDesktopDaemon(
  root: string,
  profile: DaemonProfile,
): Promise<DesktopDaemon> {
  const layout = desktopDaemonLayout(root);
  const env = desktopDaemonEnvironment(
    process.env,
    layout,
    process.env.ACE_TEST_REAL_HOME ?? homedir(),
  );
  assertTestEnvironmentIsolation(env);
  await mkdir(layout.home, { recursive: true, mode: 0o700 });
  for (const key of environmentFolders) {
    const path = env[key];
    if (path) await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const child = spawn(
    bunBinary(),
    [
      fileURLToPath(new URL("./daemon-process.ts", import.meta.url)),
      root,
      JSON.stringify(profile),
    ],
    { env, stdio: ["pipe", "pipe", "inherit"] },
  );
  const pending = new Map<number, PromiseWithResolvers<unknown>>();
  const ready = Promise.withResolvers<{ url: string; tokenPath: string }>();
  // Ends when the process does, or when it never started: a failed spawn emits no exit.
  const ended = Promise.withResolvers<void>();
  let finished = false;
  const end = () => {
    finished = true;
    ended.resolve();
  };
  let gone: Error | undefined;
  const fail = (error: Error) => {
    gone ??= error;
    ready.reject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.once("error", (error) => {
    fail(new Error(`The e2e daemon could not run: ${error.message}`));
    if (child.pid === undefined) end();
  });
  child.once("exit", (code, signal) => {
    fail(new Error(`The e2e daemon exited (${signal ?? code})`));
    end();
  });
  if (!child.stdout || !child.stdin) throw new Error("The e2e daemon has no pipes");
  // Writing after the daemon died fails with EPIPE: that fails its requests, never the spec's
  // process.
  child.stdin.on("error", (error) => fail(new Error(`The e2e daemon's stdin failed: ${error.message}`)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.startsWith(marker)) {
      // The daemon's own output, not a reply.
      process.stderr.write(`${line}\n`);
      return;
    }
    const message = DaemonReply.parse(JSON.parse(line.slice(marker.length)));
    if ("ready" in message) return ready.resolve(message.ready);
    const request = pending.get(message.id);
    pending.delete(message.id);
    if ("error" in message) request?.reject(new Error(message.error));
    else request?.resolve(decodeValue(message.value));
  });
  let next = 0;
  const stdin = child.stdin;
  const send = (request: Request): Promise<unknown> => {
    if (gone) return Promise.reject(gone);
    const id = ++next;
    const reply = Promise.withResolvers<unknown>();
    pending.set(id, reply);
    stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    return reply.promise;
  };
  const close = async () => {
    if (finished) return;
    stdin.end();
    // The daemon bounds its own close at 10 s; past 15 s it is killed.
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      await ended.promise;
    } finally {
      clearTimeout(timer);
    }
  };
  // A daemon's first start in a fresh HOME transpiles every source file.
  const startup = setTimeout(() => ready.reject(new Error("The e2e daemon did not start")), 120_000);
  try {
    const { url, tokenPath } = await ready.promise;
    // The daemon answers with the method's own result; only bytes are re-encoded on the way.
    const call = (method: BrowserMethod) => (...args: unknown[]) =>
      send({ op: "browser", method, args });
    const browser = Object.fromEntries(
      browserMethods.map((method) => [method, call(method)]),
    ) as unknown as RemoteBrowser;
    const { pid } = child;
    if (pid === undefined) throw new Error("The e2e daemon has no process");
    return {
      pid,
      url,
      tokenPath,
      browser,
      createWorkspace: async (path, name) =>
        WorkspaceId.parse(await send({ op: "workspace", path, name })),
      prepareThread: async (workspaceId, title) =>
        SpecThread.parse(await send({ op: "thread", workspaceId, title })),
      devThread: async (workspaceId) =>
        SpecThread.parse(await send({ op: "devThread", workspaceId })),
      setProfileScope: async (scope) => {
        await send({ op: "profileScope", scope });
      },
      watchVideo: async (options) => {
        const viewer = { threadId: options.threadId, connectionId: options.connectionId };
        await send({ op: "watchVideo", ...options });
        return {
          seen: async () => VideoSeen.parse(await send({ op: "videoSeen", ...viewer })),
          stop: async () => {
            await send({ op: "stopVideo", ...viewer });
          },
        };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(startup);
  }
}
