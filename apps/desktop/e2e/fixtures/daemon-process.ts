import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { Command, ThreadId, type BrowserProfileScope } from "@ace/protocol";
import { desktopDaemonLayout } from "./daemon-environment.ts";
import {
  DaemonProfile,
  DaemonRequest,
  encodeValue,
  marker,
  type DaemonReply,
} from "./daemon-protocol.ts";

/**
 * The desktop e2e daemon: a real ace daemon on Bun, its runtime, started by daemon-client.ts
 * with the environment already isolated, and driven by the specs over stdin and stdout
 * (daemon-protocol.ts). Bun's os.homedir() keeps the HOME a process started with, so isolation
 * can't be applied from in here; any other start is refused. Both checks, and the stdin watch,
 * come before the daemon's modules load.
 */
const [root, profileJson] = process.argv.slice(2);
if (!root || !profileJson) throw new Error("Start the e2e daemon with daemon-client.ts");
const layout = desktopDaemonLayout(root);
if (homedir() !== layout.root || process.env.ACE_HOME !== layout.home)
  throw new Error("Start the e2e daemon with daemon-client.ts, which isolates it");
const profile = DaemonProfile.parse(JSON.parse(profileJson));
const reply = (message: DaemonReply) => process.stdout.write(`${marker}${JSON.stringify(message)}\n`);

type Daemon = Awaited<ReturnType<typeof import("../../../daemon/src/index.ts").startDaemon>>;
let current: Daemon | undefined;
let closing = false;
/**
 * Stops the daemon and exits. It never takes longer than 10 s: a daemon whose close hangs must
 * not outlive the spec that started it.
 */
function close() {
  if (closing) return;
  closing = true;
  setTimeout(() => {
    console.error("The e2e daemon did not close within 10 s");
    process.exit(1);
  }, 10_000).unref();
  void (current?.close() ?? Promise.resolve())
    .catch((error: unknown) => console.error("The e2e daemon did not close cleanly", error))
    .finally(() => process.exit(0));
}

// Before the daemon starts: the client holds the other end of stdin, and when it closes it, or
// dies however it dies, stdin ends and this process stops, even while startup is still running.
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let request: DaemonRequest;
  try {
    request = DaemonRequest.parse(JSON.parse(line));
  } catch (error) {
    // A request with no readable id can't be answered; the spec waiting on it times out.
    console.error("The e2e daemon got an unreadable request", error);
    return;
  }
  const running = current;
  const answered = running
    ? answer(running, request)
    : Promise.reject(new Error("The e2e daemon has not started"));
  void answered.then(
    (value) => reply({ id: request.id, value }),
    (error: unknown) =>
      reply({ id: request.id, error: error instanceof Error ? error.message : String(error) }),
  );
});
lines.once("close", close);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, close);

const [{ startDaemon }, { readConfig }, { createDevThread }] = await Promise.all([
  import("../../../daemon/src/index.ts"),
  import("../../../daemon/src/config.ts"),
  import("../../../daemon/src/commands.ts"),
]);
let profileScope: BrowserProfileScope = "global";
const started =
  profile.kind === "sandbox"
    ? await startDaemon({
        config: readConfig({
          ACE_HOME: layout.home,
          ACE_PORT: "0",
          ACE_LOG_LEVEL: "silent",
          ACE_WEB_ORIGINS: profile.webOrigin,
        }),
        // Threads name Codex but no scenario starts a session; probing the machine's real CLIs
        // can outlast the engine's startup deadline and leave the sandbox without an engine.
        modelInstances: [],
        engine: {
          adapterDiscovery: async () => ({
            claude: { installed: false, auth: "unknown", loginHint: "" },
            codex: {
              installed: true,
              path: process.execPath,
              version: "0.0.0",
              auth: "unknown",
              loginHint: "",
            },
            cursor: { installed: false, auth: "unknown", loginHint: "" },
            opencode: { installed: false, auth: "unknown", loginHint: "" },
          }),
        },
        browser: {
          executablePath: profile.chromium,
          backendPreference: () => profile.backend,
          profileScope: () => profileScope,
        },
      })
    : await startDaemon({
        config: readConfig({ ACE_HOME: layout.home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
        browser: { executablePath: "/unavailable/headless" },
      });

function prepareThread(daemon: Daemon, request: Extract<DaemonRequest, { op: "thread" }>) {
  const engine = daemon.engine;
  if (!engine) throw new Error("The e2e daemon has no engine");
  const threadId = ThreadId.parse(randomUUID());
  const result = engine.handler.handle(
    Command.parse({
      id: randomUUID(),
      deviceId: "sandbox",
      payload: {
        type: "thread.prepare",
        threadId,
        workspaceId: request.workspaceId,
        provider: "codex",
        title: request.title,
      },
    }),
    daemon.store,
  );
  if (!result.ok) throw new Error(`Thread preparation failed: ${result.error}`);
  // Home leaves empty drafts out of its list; the scenarios switch threads from it.
  daemon.store.appendEvents(threadId, [
    { type: "thread.client.updated", changes: { hasSentMessage: true } },
  ]);
  const thread = daemon.store.getThread(threadId);
  if (!thread) throw new Error("The prepared thread is missing");
  return thread;
}

/**
 * Remote viewers of a page's live video, as a web connection is one: each counts the chunks
 * and keyframes it receives and acknowledges every chunk, as a client does. A viewer's sink
 * is a callback, so it lives here and the spec reads its counts.
 */
type Viewer = { chunks: number; keyframes: number; stop(): void };
const viewers = new Map<string, Viewer>();
const viewerKey = (request: { threadId: string; connectionId: string }) =>
  `${request.threadId} ${request.connectionId}`;
function watchVideo(daemon: Daemon, request: Extract<DaemonRequest, { op: "watchVideo" }>) {
  const { threadId, connectionId } = request;
  const viewer: Viewer = { chunks: 0, keyframes: 0, stop: () => {} };
  viewer.stop = daemon.browser.subscribe(
    threadId,
    connectionId,
    {
      video: {
        send(chunk) {
          viewer.chunks++;
          if (chunk.key) viewer.keyframes++;
          queueMicrotask(() =>
            daemon.browser.acknowledgeVideo(threadId, connectionId, chunk.sequence),
          );
          return true;
        },
      },
    },
    () => {},
  );
  viewers.set(viewerKey(request), viewer);
  daemon.browser.configureCapture(threadId, connectionId, {
    viewport: { ...request.viewport, devicePixelRatio: 1 },
    video: { codecs: request.codecs },
  });
  return null;
}
function videoSeen(request: { threadId: string; connectionId: string }) {
  const viewer = viewers.get(viewerKey(request));
  if (!viewer) throw new Error("No viewer watches that page");
  return { chunks: viewer.chunks, keyframes: viewer.keyframes };
}

async function answer(daemon: Daemon, request: DaemonRequest): Promise<unknown> {
  switch (request.op) {
    case "workspace":
      return daemon.store.createWorkspace(request.path, request.name);
    case "thread":
      return prepareThread(daemon, request);
    case "devThread":
      return createDevThread(daemon.store, request.workspaceId);
    case "profileScope":
      profileScope = request.scope;
      return null;
    case "browser": {
      // The specs pass what the service's own callers pass; its methods check their input.
      const method: unknown = Reflect.get(daemon.browser, request.method);
      if (typeof method !== "function") throw new Error(`No browser method ${request.method}`);
      return encodeValue((await Reflect.apply(method, daemon.browser, request.args)) ?? null);
    }
    case "watchVideo":
      return watchVideo(daemon, request);
    case "videoSeen":
      return videoSeen(request);
    case "stopVideo":
      videoSeen(request);
      viewers.get(viewerKey(request))?.stop();
      viewers.delete(viewerKey(request));
      return null;
  }
}

current = started;
// A close that began during startup closes the daemon it was waiting for.
if (closing) void started.close().finally(() => process.exit(0));
else reply({ ready: { url: started.url, tokenPath: started.tokenPath } });
