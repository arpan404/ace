import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createTurnProvider } from "@ace/adapter-testkit";
import { AdapterRegistry, readConfig, startDaemon } from "@ace/daemon";
import { ServerMessage, WorkspaceId, type CommandPayload } from "@ace/protocol";
import { prepareDaemonHome } from "@ace/service";

/*
 * The Deck flow test's daemon (deck-flow.ts starts it): a real daemon, ace-files and all, in the
 * temporary home it was started in, on one temporary checkout, with a scripted Claude Code whose
 * every reply links `reply`'s file. It never starts a CLI. It prints where it listens and its
 * thread, then runs until its stdin closes (the test, however it ends).
 */

const [home, checkout, origin, reply] = process.argv.slice(2);
if (!home || !checkout || !origin || !reply) throw new Error("deck-flow-daemon: missing arguments");
// Isolation is applied by the caller, before this process starts: refuse any other start.
if (homedir() !== home || process.env.ACE_HOME !== home)
  throw new Error("deck-flow-daemon: start it through deck-flow.ts, which isolates its home");

prepareDaemonHome(home);
const registry = new AdapterRegistry();
registry.register(
  createTurnProvider({
    provider: "claude",
    reply,
    config: { delayMs: 0, limitAfterTurns: 0, resetMs: 1000 },
    now: Date.now,
    schedule(delayMs, callback) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  }),
  { installed: true, auth: "logged_in", loginHint: "scripted" },
);
const daemon = await startDaemon({
  config: { ...readConfig(), dataDir: home, port: 0, logLevel: "warn", webOrigins: [origin] },
  engine: { registry },
  modelInstances: [],
  providerStatus: {
    env: { ...process.env, PATH: "" },
    cursorSdk: async () => ({ installed: false, auth: "unknown", loginHint: "Scripted" }),
    versions: async () => ({}),
  },
});
// Files resolve only canonical roots (macOS's tmpdir is behind a symlink).
const workspace = daemon.store.createWorkspace(realpathSync(checkout), "Deck flow");
const token = readFileSync(daemon.tokenPath, "utf8").trim();
const threadId = await command(daemon.url, token, {
  type: "thread.create",
  workspaceId: WorkspaceId.parse(workspace),
  provider: "claude",
  title: "Deck flow",
  input: [{ type: "text", text: "Where should I start?" }],
});
process.stdout.write(`${JSON.stringify({ url: daemon.url, token, threadId })}\n`);

process.stdin.resume();
process.stdin.once("close", () => {
  void daemon.close().finally(() => process.exit(0));
});

/** One command, sent as any client sends it; the thread it created. */
async function command(url: string, token: string, payload: CommandPayload): Promise<string> {
  const socket = new WebSocket(url);
  const id = randomUUID();
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const result = new Promise<string>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        const parsed = ServerMessage.safeParse(JSON.parse(String(event.data)));
        if (!parsed.success || parsed.data.type !== "commandResult") return;
        if (parsed.data.commandId !== id) return;
        if (parsed.data.ok && parsed.data.threadId) resolve(parsed.data.threadId);
        else reject(new Error(`${payload.type} failed: ${parsed.data.error ?? "no thread"}`));
      });
    });
    const deviceId = "deck-flow";
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, deviceId, token }));
    socket.send(JSON.stringify({ type: "command", command: { id, deviceId, payload } }));
    return await result;
  } finally {
    socket.close();
  }
}
