import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createScriptedAdapter, type ScriptedStep } from "@ace/adapter-testkit";
import type { Fact } from "@ace/core";
import { AdapterRegistry, readConfig, startDaemon } from "@ace/daemon";
import type { Frame, SessionContext } from "@ace/engine-api";
import { Capabilities, ServerMessage, type ContentPart, type ProviderKind } from "@ace/protocol";
import { deckTurn } from "./deck-script.ts";
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
  webOrigin,
  pairedDeviceName,
} from "./real-daemon-config.ts";

/**
 * A real ace daemon (apps/daemon) for the e2e smoke test, with scripted providers from
 * @ace/adapter-testkit registered in place of discovery, so no provider CLI is ever started.
 * Each message a thread receives is answered with `scriptedReply` and the turn ends.
 */
const replies = 20;

const message = (item: string, role: "user" | "assistant", text: string): Fact => ({
  type: "item.upsert",
  agent: "root",
  item,
  draft: { type: "message", role, complete: true, parts: [{ type: "text", text }] },
});

const end = (outcome: "completed" | "interrupted") =>
  ({ type: "turn.ended", agent: "root", outcome }) satisfies Fact;

/**
 * The testkit's scripted adapter, with each message answered by one turn: the person's text
 * (providers echo user input; the engine does not), the scripted reply, then the turn ends.
 */
function scriptedProvider(provider: ProviderKind) {
  const bundles = new Map<string, Fact[]>();
  let seq = 0;
  const frame = (...facts: Fact[]): Frame => {
    const channel = `facts-${++seq}`;
    bundles.set(channel, facts);
    return { seq, t: seq, dir: "recv", channel, data: { scripted: true } };
  };
  const adapter = createScriptedAdapter({
    provider,
    nativeSessionId: `scripted-${provider}`,
    capabilities: Capabilities.parse({
      steer: true,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: true,
      backgroundTaskControl: true,
      backgroundVisibility: "full",
      planMode: false,
      tokenUsage: false,
      imageInput: true,
      rewindFiles: false,
    }),
    createTranslator: () => ({
      translate: (incoming) => structuredClone(bundles.get(incoming.channel) ?? []),
      tick: () => [],
    }),
    steps: Array.from({ length: replies }, (): ScriptedStep => ({ on: "send" })),
  });
  return {
    ...adapter,
    async openSession(ctx: SessionContext) {
      const session = await adapter.openSession(ctx);
      // A turn started by a message carrying `holdMarker` keeps working until the person
      // steers into it or stops it, so the server queue has a running turn to queue behind.
      let holding = false;
      // A Deck worker's open question, answered through `resolve`.
      let asking: { turn: number; answer(): string } | undefined;
      return {
        ...session,
        async send(input: ContentPart[], delivery: "steer" | "queue") {
          await session.send(input, delivery);
          const text = input
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
          const turn = ++seq;
          const ask = message(`ask-${turn}`, "user", text);
          const reply = message(`reply-${turn}`, "assistant", scriptedReply);
          const deck = deckTurn(text, ctx.cwd);
          if (deck) {
            // A Deck lane works for a moment, then returns its role's artifact (or asks first).
            ctx.onFrame(frame({ type: "turn.started", agent: "root", trigger: "user" }, ask));
            setTimeout(() => {
              if (deck.kind === "reply") {
                ctx.onFrame(
                  frame(message(`reply-${turn}`, "assistant", deck.text), end("completed")),
                );
                return;
              }
              asking = { turn, answer: deck.answer };
              ctx.onFrame(
                frame({
                  type: "interaction.opened",
                  agent: "root",
                  interaction: `ask-${turn}`,
                  blocking: true,
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
                }),
              );
            }, deckStepMs);
            return;
          }
          if (holding) {
            // Steered into the held turn: answer it and finish.
            holding = false;
            ctx.onFrame(frame(ask, reply, end("completed")));
          } else if (text.includes(holdMarker)) {
            holding = true;
            ctx.onFrame(frame({ type: "turn.started", agent: "root", trigger: "user" }, ask));
          } else if (text.includes(limitMarker)) {
            ctx.onFrame(
              frame({ type: "turn.started", agent: "root", trigger: "user" }, ask, {
                type: "retry",
                agent: "root",
                on: "rate_limit",
                message: limitNotice,
              }),
            );
          } else {
            ctx.onFrame(
              frame(
                { type: "turn.started", agent: "root", trigger: "user" },
                ask,
                reply,
                end("completed"),
              ),
            );
          }
        },
        async resolve() {
          // The testkit's script has no resolve step. The engine closes the question; the
          // worker then finishes its card.
          const open = asking;
          if (!open) return;
          asking = undefined;
          ctx.onFrame(
            frame(message(`reply-${open.turn}`, "assistant", open.answer()), end("completed")),
          );
        },
        async close(reason: Parameters<typeof session.close>[0]) {
          // The testkit's script has no close step; the session still exits, which is all a
          // restart or a resume after a limit needs.
          await session.close(reason).catch(() => {});
        },
        async interrupt() {
          // Stop ends a held turn; the testkit's script never sees it, so it can't run out.
          if (!holding) return;
          holding = false;
          ctx.onFrame(frame(end("interrupted")));
        },
      };
    },
  };
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
