import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createTurnProvider, ScriptedTurnConfig } from "@ace/adapter-testkit";
import { deckTurn } from "./deck-script.ts";
import { AdapterRegistry, readConfig, startDaemon } from "@ace/daemon";
import { ThreadId, WorkspaceId, type CommandPayload, type ProviderKind } from "@ace/protocol";
import { daemonCommands } from "./daemon-socket.ts";
import {
  deckStepMs,
  daemonHome,
  daemonPort,
  pluginMarketPath,
  pluginName,
  holdMarker,
  limitMarker,
  limitNotice,
  scriptedReply,
  screensTitle,
  seededTitle,
  workerTitle,
  workspaceName,
  workspaceTitle,
  scriptOutput,
  previewTitle,
  settleTitle,
  snoozeTitle,
  forkTitle,
  deleteTitle,
  queueTitle,
  limitTitle,
  longAsk,
  longTitle,
  longTurns,
  webOrigin,
  pairedDeviceName,
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
    markers: { hold: holdMarker, limit: limitMarker, notice: limitNotice },
    respond(text, cwd) {
      const deck = deckTurn(text, cwd);
      if (!deck) return;
      if (deck.kind === "reply") return { ...deck, delayMs: deckStepMs };
      return {
        kind: "question",
        delayMs: deckStepMs,
        answer: deck.answer,
        request: {
          kind: "question",
          questions: [
            {
              id: "where",
              text: deck.question,
              options: [
                { id: "root", label: "Yes, at the root" },
                { id: "docs", label: "No, under docs/" },
              ],
              multiSelect: false,
              allowOther: false,
            },
          ],
        },
      };
    },
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
// The daemon commits as whoever the checkout names, as it does on a person's machine.
git("config", "user.name", "ace e2e");
git("config", "user.email", "e2e@ace.invalid");
git("add", "README.md");
git("commit", "-q", "-m", "Initial commit");
// A script for the header's Run button, and an uncommitted edit for its git control.
writeFileSync(
  join(project, "package.json"),
  `${JSON.stringify(
    {
      name: "e2e-project",
      private: true,
      scripts: {
        greet: `echo ${scriptOutput}`,
      },
    },
    null,
    2,
  )}\n`,
);
git("add", "package.json");
git("commit", "-q", "-m", "Add a script");
writeFileSync(join(project, "README.md"), "# e2e project\n\nEdited by the workspace journey.\n");

seedPluginMarket();

// An editor on the daemon's PATH, so Open has the same choice on every machine. The daemon only
// lists and validates it; the app hands the launch to this machine, so it never runs.
const editors = join(daemonHome, "bin");
mkdirSync(editors, { recursive: true });
writeFileSync(join(editors, "zed"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
process.env.PATH = `${editors}${delimiter}${process.env.PATH ?? ""}`;

const registry = new AdapterRegistry();
for (const provider of ["claude", "codex"] as const)
  registry.register(scriptedProvider(provider), {
    installed: true,
    auth: "logged_in",
    loginHint: "scripted",
  });

const daemon = await startDaemon({
  config: {
    ...readConfig({}),
    dataDir: daemonHome,
    port: daemonPort,
    logLevel: "warn",
    webOrigins: [webOrigin],
  },
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
await seedThread(daemon.url, daemonToken, workspace, workspaceTitle, "Get the project ready.");
await seedThread(daemon.url, daemonToken, workspace, settleTitle, "Tidy the README.");
await seedThread(daemon.url, daemonToken, workspace, snoozeTitle, "Look at this tomorrow.");
await seedThread(daemon.url, daemonToken, workspace, forkTitle, "Tidy the README.");
await seedThread(daemon.url, daemonToken, workspace, deleteTitle, "Try something throwaway.");
await seedThread(daemon.url, daemonToken, workspace, previewTitle, "Show me the page.");
await seedThread(daemon.url, daemonToken, workspace, queueTitle, "Warm up the queue.");
await seedThread(daemon.url, daemonToken, workspace, limitTitle, "Warm up before the limit.");
if (longTurns > 0) await seedLongThread(daemon.url, daemonToken, workspace, longTurns);
daemon.store.devices.create(pairedDeviceName, ["read", "operate"], Date.now());
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
): Promise<string> {
  const [created] = await daemonCommands(url, token, [
    {
      type: "thread.create",
      workspaceId: WorkspaceId.parse(workspaceId),
      provider: "claude",
      title,
      input: [{ type: "text", text }],
    },
  ]);
  if (!created?.threadId) throw new Error("thread.create returned no thread");
  return created.threadId;
}

/**
 * A thread of `turns` turns, each a person's checkpoint and the scripted reply, so its oldest
 * turns are far behind the daemon's 200-item snapshot. Follow-ups queue behind the running
 * turn and run one after another, as a person's would.
 */
async function seedLongThread(url: string, token: string, workspaceId: string, turns: number) {
  const threadId = await seedThread(url, token, workspaceId, longTitle, longAsk(1));
  const sends: CommandPayload[] = [];
  for (let n = 2; n <= turns; n++)
    sends.push({
      type: "thread.send",
      threadId: ThreadId.parse(threadId),
      input: [{ type: "text", text: longAsk(n) }],
      delivery: "queue",
    });
  await daemonCommands(url, token, sends);
}

/** A marketplace with one plugin: a skill, a command and an MCP server its review shows. */
function seedPluginMarket(): void {
  const root = join(pluginMarketPath, "plugins", pluginName);
  const files: Record<string, string> = {
    "marketplace.json": JSON.stringify({
      name: "e2e-market",
      plugins: [{ name: pluginName, source: `./plugins/${pluginName}` }],
    }),
    [`plugins/${pluginName}/ace-plugin.json`]: JSON.stringify({
      schemaVersion: 1,
      name: pluginName,
      version: "1.0.0",
      description: "Tools for the e2e project",
      skills: [{ name: "greet", path: "skills/greet" }],
      commands: [{ name: "standup", path: "commands/standup.md" }],
      agents: [],
      rules: [],
      mcpServers: {
        notes: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.js"], env: {} },
      },
    }),
    [`plugins/${pluginName}/skills/greet/SKILL.md`]:
      "---\nname: greet\ndescription: Greet the team\n---\nSay hello to everyone in the thread.\n",
    [`plugins/${pluginName}/commands/standup.md`]:
      "---\ndescription: Summarise the day\n---\nSummarise what moved today.\n",
    [`plugins/${pluginName}/server.js`]: "throw new Error('never runs during the e2e');\n",
  };
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(pluginMarketPath, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  commitAll(pluginMarketPath, "Plugin market");
}

/** A fresh repository at `cwd` holding everything in it as one commit. */
function commitAll(cwd: string, subject: string): void {
  const run = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=ace e2e", "-c", "user.email=e2e@ace.invalid", ...args], {
      cwd,
      stdio: "ignore",
    });
  run("init", "-q", "-b", "main");
  run("add", ".");
  run("commit", "-q", "-m", subject);
}
