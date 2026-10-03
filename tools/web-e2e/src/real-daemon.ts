import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTurnProvider, ScriptedTurnConfig } from "@ace/adapter-testkit";
import { AdapterRegistry, readConfig, startDaemon } from "@ace/daemon";
import { ServerMessage, type ProviderKind } from "@ace/protocol";
import {
  daemonHome,
  daemonPort,
  scriptedReply,
  screensTitle,
  seededTitle,
  workerTitle,
  workspaceName,
} from "./real-daemon-config.ts";

/**
 * A real ace daemon (apps/daemon) for the e2e smoke test, with scripted providers from
 * @ace/adapter-testkit registered in place of discovery, so no provider CLI is ever started.
 * Each message a thread receives is answered with `scriptedReply` and the turn ends.
 */
const scriptedConfig = ScriptedTurnConfig.parse({
  delayMs: Number(process.env.ACE_E2E_TURN_DELAY_MS ?? 0),
  limitAfterTurns: Number(process.env.ACE_E2E_LIMIT_AFTER_TURNS ?? 0),
  resetMs: Number(process.env.ACE_E2E_LIMIT_RESET_MS ?? 1000),
});
function scriptedProvider(provider: ProviderKind) {
  return createTurnProvider({
    provider,
    reply: scriptedReply,
    config: scriptedConfig,
    now: Date.now,
    schedule(delayMs, callback) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  });
}

rmSync(daemonHome, { recursive: true, force: true });
const project = join(daemonHome, "projects", workspaceName);
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "README.md"), "# e2e project\n");
// Context (mentions, uploads) works inside a git checkout, as a real project is.
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=ace e2e", "-c", "user.email=e2e@ace.invalid", ...args], {
    cwd: project,
    stdio: "ignore",
  });
git("init", "-q", "-b", "main");
git("add", "README.md");
git("commit", "-q", "-m", "Initial commit");

const registry = new AdapterRegistry();
for (const provider of ["claude", "codex"] as const)
  registry.register(scriptedProvider(provider), {
    installed: true,
    auth: "logged_in",
    loginHint: "scripted",
  });

const daemon = await startDaemon({
  config: { ...readConfig({}), dataDir: daemonHome, port: daemonPort, logLevel: "warn" },
  engine: { registry },
});
// Context and files resolve only canonical roots (macOS's tmpdir is behind a symlink).
const workspace = daemon.store.createWorkspace(realpathSync(project), workspaceName);
const daemonToken = readFileSync(daemon.tokenPath, "utf8").trim();
await seedThread(
  daemon.url,
  daemonToken,
  workspace,
  seededTitle,
  "Say hello from the scripted provider.",
);
await seedThread(daemon.url, daemonToken, workspace, screensTitle, "List what is in this project.");
await seedThread(daemon.url, daemonToken, workspace, workerTitle, "Greet both tabs.");
process.stdout.write(`e2e daemon ready on ${daemon.url}\n`);

const stop = () => void daemon.close().finally(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

/** One thread created the way any client creates one, so Home has something to open. */
async function seedThread(
  url: string,
  token: string,
  workspaceId: string,
  title: string,
  text: string,
): Promise<void> {
  const deviceId = "e2e-seed";
  const socket = new WebSocket(url);
  const result = new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      const parsed = ServerMessage.safeParse(JSON.parse(String(event.data)));
      if (!parsed.success) return;
      const reply = parsed.data;
      if (reply.type === "commandResult")
        return reply.ok ? resolve() : reject(new Error(`thread.create failed: ${reply.error}`));
      if (reply.type === "error") reject(new Error(String(event.data)));
    });
    socket.addEventListener("error", () => reject(new Error("Seed socket failed")));
  });
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, deviceId, token }));
  socket.send(
    JSON.stringify({
      type: "command",
      command: {
        id: randomUUID(),
        deviceId,
        payload: {
          type: "thread.create",
          workspaceId,
          provider: "claude",
          title,
          input: [{ type: "text", text }],
        },
      },
    }),
  );
  await result;
  socket.close();
}
