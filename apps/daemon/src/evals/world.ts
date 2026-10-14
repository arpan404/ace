import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { detectChromium } from "@ace/browser";
import { claudeInjection, codexInjection, type AceMcpConnection } from "@ace/mcp-server";
import { ScreenManager } from "@ace/screen";
import type { Fact } from "@ace/core";
import type { AccessMode, ThreadId, ProviderKind } from "@ace/protocol";
import { readConfig, startDaemon } from "../index.ts";
import { setup } from "../agent-control/test-support.ts";
import { end, start } from "../engine/test-support.ts";
import { scriptedModelInstance, seedScriptedModels } from "../testing/models.ts";
import { EvalAgent } from "./agent.ts";

/** Which native instruction channel the scripted model reads, as the real adapter injects it. */
export type Delivery = "claude" | "codex";

/** Seeded page: one console error and one failing request, as a broken dev server would. */
export const seededConsoleError = "seeded: login widget failed to mount";
// The heading appears only after the failing request settles, so waiting for it is enough.
const page = `<!doctype html><title>Login</title>
<script>console.error(${JSON.stringify(seededConsoleError)});
fetch("/api/session").finally(() => document.body.insertAdjacentHTML("beforeend", "<h1>Sign in</h1>"));</script>`;

/**
 * Real daemon, real ace MCP server, scripted provider CLIs and models. Nothing reaches a provider.
 * The parent thread is created the way a person creates one; its provider session receives the
 * real ace MCP lease, which the scripted agent then uses exactly as a provider CLI would.
 */
export async function evalWorld(options: { browser: boolean }) {
  const h = setup();
  const project = join(h.home, "shop");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# shop\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: project, stdio: "ignore", env: gitEnv });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("checkout", "-q", "-b", "feat/login");
  const executablePath = options.browser ? await detectChromium() : undefined;
  const pages: Server = createServer((request, response) => {
    if (request.url === "/api/session") response.writeHead(500).end("seeded failure");
    else response.writeHead(200, { "Content-Type": "text/html" }).end(page);
  });
  await new Promise<void>((resolve) => pages.listen(0, "127.0.0.1", resolve));
  const address = pages.address();
  if (!address || typeof address === "string") throw new Error("Missing dev server address");
  const devServerUrl = `http://127.0.0.1:${address.port}/`;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [new URL("../testing/mcp-screen-helper.ts", import.meta.url).pathname],
    env: { ACE_FEATURE_SCREEN_JOURNAL: join(h.home, "screen.jsonl") },
    platform: "darwin",
    nextId: (() => {
      let sequence = 0;
      return () => `screen-${++sequence}`;
    })(),
    recordingDirectory: h.home,
    publishArtifact: async () => {},
  });
  writeFileSync(join(h.home, "screen.jsonl"), "");
  const daemon = await startDaemon({
    config: readConfig({
      ACE_HOME: join(h.home, "daemon"),
      ACE_PORT: "0",
      ACE_LOG_LEVEL: "silent",
    }),
    engine: { registry: h.registry, clock: h.clock },
    modelInstances: [],
    screen,
    ...(executablePath ? { browser: { executablePath } } : {}),
    workspaceActions: {
      forgeRunner: () => async () => ({ code: 1, stdout: "offline", truncated: false }),
    },
  });
  // Screen is on, so a read-only thread is the only thing keeping screen tools away.
  await screen.enable(true);
  await daemon.settings.set("access.defaultMode", "full-access", { kind: "global" });
  for (const provider of ["codex", "claude"] as const)
    await seedScriptedModels(daemon.models, scriptedModelInstance(provider, h.home));
  const controls = daemon.agentControl;
  const engine = daemon.engine;
  if (!controls || !engine) throw new Error("Agent control unavailable");
  const workspaceId = daemon.store.createWorkspace(project, "shop");
  const agents: EvalAgent[] = [];
  const threads: ThreadId[] = [];
  let sequence = 0;

  async function createThread(provider: ProviderKind, access: AccessMode, text: string) {
    const result = controls?.delegations.command(`create-${++sequence}`, {
      type: "thread.create",
      workspaceId,
      provider,
      access,
      input: [{ type: "text", text }],
    });
    await engine?.flush();
    const thread = result?.threadId ? daemon.store.getThread(result.threadId) : undefined;
    if (!thread?.rootAgentId) throw new Error("Thread unavailable");
    return thread;
  }
  async function emit(thread: ThreadId, ...facts: Fact[]) {
    // A child's provider session opens asynchronously after delegation is accepted.
    for (let attempt = 0; attempt < 200 && !h.contexts.has(thread); attempt++) {
      await engine?.flush();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const context = h.contexts.get(thread);
    if (!context) throw new Error("Missing provider session");
    context.onFrame(h.frames.frame(...facts));
    await engine?.flush();
  }

  return {
    daemon,
    store: daemon.store,
    workspaceId,
    devServerUrl,
    branch: "feat/login",
    browser: Boolean(executablePath),
    /** A person's new thread, with the scripted model attached to its real ace MCP lease. */
    async agent(input: {
      access?: AccessMode;
      prompt?: string;
      delivery?: Delivery;
    }): Promise<{ agent: EvalAgent; threadId: ThreadId; connection: AceMcpConnection }> {
      const thread = await createThread(
        "codex",
        input.access ?? "full-access",
        input.prompt ?? "help me with the login page",
      );
      const connection = h.contexts.get(thread.id)?.aceMcp;
      if (!connection) throw new Error("The provider session received no ace MCP lease");
      const delivery = input.delivery ?? "claude";
      const agent = await EvalAgent.connect({
        url: connection.url,
        bearer: connection.bearer,
        nativeInstructions:
          delivery === "claude"
            ? claudeInjection(connection).developerInstructions
            : codexInjection(connection).developerInstructions,
        serverInstructions: delivery === "claude",
      });
      agents.push(agent);
      threads.push(thread.id);
      return { agent, threadId: thread.id, connection };
    },
    /** Earlier work in the same project: a finished thread with a final answer. */
    async finishedThread(prompt: string, answer: string) {
      const thread = await createThread("claude", "full-access", prompt);
      await this.complete(thread.id, answer);
      return thread.id;
    },
    /** Another thread in the project whose model is still working. */
    async liveThread(prompt: string) {
      return (await createThread("claude", "full-access", prompt)).id;
    },
    /** The scripted child model writes its answer and ends its turn. */
    async complete(thread: ThreadId, text: string) {
      await emit(
        thread,
        {
          type: "item.upsert",
          agent: "root",
          item: `answer-${++sequence}`,
          draft: {
            type: "message",
            role: "assistant",
            parts: [{ type: "text", text }],
            complete: true,
          },
        },
        end,
      );
      h.clock.advance(1_000);
      await engine.flush();
    },
    /** Each child whose task matches a key answers with its value, as children start. */
    async answerChildren(answers: ReadonlyMap<string, string>) {
      const done = new Set<string>();
      for (let attempt = 0; attempt < 2_000 && done.size < answers.size; attempt++) {
        for (const [thread, inputs] of h.inputs)
          for (const [task, answer] of answers)
            if (!done.has(task) && inputs.some((text) => text.includes(task))) {
              done.add(task);
              await this.complete(thread, answer);
            }
        await engine.flush();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (done.size < answers.size) throw new Error("Children never started");
    },
    /** The scripted child model stops to ask the person a blocking question. */
    async askHuman(thread: ThreadId) {
      await emit(thread, start, {
        type: "interaction.opened",
        agent: "root",
        interaction: `question-${++sequence}`,
        blocking: true,
        request: {
          kind: "question",
          questions: [
            {
              id: "which",
              text: "Which login provider?",
              options: [{ id: "email", label: "Email" }],
              multiSelect: false,
              allowOther: false,
            },
          ],
        },
      });
    },
    flush: () => engine.flush(),
    async close() {
      for (const agent of agents) await agent.close().catch(() => {});
      // Like a person closing the thread: its browser goes before the daemon does.
      if (executablePath) for (const thread of threads) await daemon.browser.closeThread(thread);
      await daemon.close();
      await screen.close();
      pages.closeAllConnections();
      await new Promise<void>((resolve) => pages.close(() => resolve()));
    },
  };
}
export type EvalWorld = Awaited<ReturnType<typeof evalWorld>>;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "ace eval",
  GIT_AUTHOR_EMAIL: "eval@ace.invalid",
  GIT_COMMITTER_NAME: "ace eval",
  GIT_COMMITTER_EMAIL: "eval@ace.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};
