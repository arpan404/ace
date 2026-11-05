import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { Command, ThreadId, type BrowserProfileScope } from "@ace/protocol";
import { startDaemon } from "../../../daemon/src/index.ts";
import { readConfig } from "../../../daemon/src/config.ts";
import { createDevThread } from "../../../daemon/src/commands.ts";
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
 * can't be applied from in here; any other start is refused.
 */
const [root, profileJson] = process.argv.slice(2);
if (!root || !profileJson) throw new Error("Start the e2e daemon with daemon-client.ts");
const layout = desktopDaemonLayout(root);
if (homedir() !== layout.root || process.env.ACE_HOME !== layout.home)
  throw new Error("Start the e2e daemon with daemon-client.ts, which isolates it");
const profile = DaemonProfile.parse(JSON.parse(profileJson));
const reply = (message: DaemonReply) => process.stdout.write(`${marker}${JSON.stringify(message)}\n`);

let profileScope: BrowserProfileScope = "global";
const daemon =
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

function prepareThread(request: Extract<DaemonRequest, { op: "thread" }>) {
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
function watchVideo(request: Extract<DaemonRequest, { op: "watchVideo" }>) {
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

async function answer(request: DaemonRequest): Promise<unknown> {
  switch (request.op) {
    case "workspace":
      return daemon.store.createWorkspace(request.path, request.name);
    case "thread":
      return prepareThread(request);
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
      return watchVideo(request);
    case "videoSeen":
      return videoSeen(request);
    case "stopVideo":
      videoSeen(request);
      viewers.get(viewerKey(request))?.stop();
      viewers.delete(viewerKey(request));
      return null;
  }
}

let closing: Promise<void> | undefined;
const close = () =>
  (closing ??= daemon
    .close()
    .catch((error: unknown) => console.error("The e2e daemon did not close cleanly", error))
    .finally(() => process.exit(0)));

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = DaemonRequest.parse(JSON.parse(line));
  void answer(request).then(
    (value) => reply({ id: request.id, value }),
    (error: unknown) =>
      reply({ id: request.id, error: error instanceof Error ? error.message : String(error) }),
  );
});
// The client holds the other end of stdin. When it closes it, or dies however it dies, stdin
// ends and the daemon stops rather than outliving the spec.
lines.once("close", () => void close());
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void close());
reply({ ready: { url: daemon.url, tokenPath: daemon.tokenPath } });
