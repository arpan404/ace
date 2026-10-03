import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { startDaemon, readConfig, AdapterRegistry } from "@ace/daemon";
import { once } from "node:events";
import { Client } from "../socket-test-support.ts";

import {
  Capabilities,
  Command,
  ConductorSpec,
  DeviceId,
  type CommandPayload,
  type ThreadId,
  type ConductorPlan,
  type ConductorRunView,
  ServerMessage,
} from "@ace/protocol";
import { type SessionContext } from "@ace/engine-api";
import { type Fact } from "@ace/core";
import { scriptFrames, start, end } from "../engine/test-support.ts";
import { scriptedForge } from "./test-forge.ts";
import { plan, review } from "./test-artifacts.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
export function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Real daemon, sockets, SQLite and Git. Only the installed provider boundary is scripted. */
export async function deckFixture(
  options: {
    hold?: boolean;
    question?: boolean;
    parallel?: number;
    cards?: ConductorPlan;
    planApproval?: "auto" | "required";
    hostCapacity?: number;
    prOnly?: boolean;
    wrongReviewRevision?: boolean;
    quotaLimit?: boolean;
    stallAfterMs?: number;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "ace-deck-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Deck fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "commit.gpgSign", "false");
  git(repo, "commit", "--allow-empty", "-m", "base");
  const original = git(repo, "rev-parse", "HEAD");
  const forge = scriptedForge();
  if (options.prOnly) {
    const remote = join(home, "remote.git");
    git(home, "init", "--bare", remote);
    git(repo, "remote", "add", "origin", "https://github.com/octo/ace.git");
    git(repo, "remote", "set-url", "--push", "origin", remote);
    git(repo, "push", "origin", "main");
  }
  const frames = scriptFrames();
  const registry = new AdapterRegistry();
  const contexts = new Map<ThreadId, SessionContext>();
  const roles = new Map<ThreadId, string>();
  const sends: { thread: ThreadId; text: string; cwd: string; resumed: boolean }[] = [];
  let hold = options.hold ?? false;
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  const output = async (ctx: SessionContext, ...facts: Fact[]) => {
    await ctx.onFrame(frames.frame(...facts));
  };
  async function finish(threadId: ThreadId) {
    const ctx = contexts.get(threadId);
    if (!ctx) throw new Error("No scripted session");
    const role = roles.get(threadId) ?? "nested";
    const card = role.split(": ").at(-1) ?? "a";
    let artifact: unknown = { message: "nested result" };
    if (role.includes("planner")) artifact = { kind: "plan", plan: options.cards ?? plan() };
    else if (role.includes("reviewer"))
      artifact = {
        kind: "review",
        revision: options.wrongReviewRevision ? "0".repeat(40) : git(ctx.cwd, "rev-parse", "HEAD"),
        review: review(card),
      };
    else if (role.includes("worker") || role.includes("integrator")) {
      writeFileSync(join(ctx.cwd, `${card}.txt`), `${card} works\n`);
      git(ctx.cwd, "add", "--", `${card}.txt`);
      git(ctx.cwd, "commit", "--allow-empty", "-m", `Implement ${card}`);
      artifact = {
        kind: "completion",
        completion: {
          branch: git(ctx.cwd, "branch", "--show-current"),
          revision: git(ctx.cwd, "rev-parse", "HEAD"),
          summary: `Implemented ${card}`,
        },
      };
    }
    await output(
      ctx,
      {
        type: "item.upsert",
        agent: "root",
        item: `result-${randomUUID()}`,
        draft: {
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text: JSON.stringify(artifact) }],
          complete: true,
        },
      },
      end,
    );
  }
  const scripted = createScriptedAdapter({
    provider: "codex",
    capabilities: Capabilities.parse({
      steer: false,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: true,
      backgroundTaskControl: true,
      backgroundVisibility: "full",
      planMode: false,
      tokenUsage: false,
      imageInput: false,
      rewindFiles: false,
    }),
    steps: [],
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
  });
  registry.register(
    {
      ...scripted,
      async openSession(ctx) {
        contexts.set(ctx.threadId, ctx);
        const session = await scripted.openSession(ctx);
        return {
          ...session,
          nativeSessionId: ctx.resume?.nativeSessionId ?? `script-${ctx.threadId}`,
          async send(input, delivery) {
            await session.send(input, delivery);
            const text = input
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n");
            sends.push({ thread: ctx.threadId, text, cwd: ctx.cwd, resumed: !!ctx.resume });
            const role = daemon.store.getThread(ctx.threadId)?.title ?? "nested";
            roles.set(ctx.threadId, role);
            await output(ctx, start);
            if (role.includes("worker") && options.quotaLimit && !ctx.resume) {
              await output(ctx, {
                ...end,
                outcome: "failed",
                error: { kind: "quota", message: "Scripted local quota hold" },
              });
            } else if (role.includes("worker") && options.question && !ctx.resume) {
              await output(ctx, {
                type: "interaction.opened",
                agent: "root",
                interaction: "choice",
                blocking: true,
                request: {
                  kind: "question",
                  questions: [
                    {
                      id: "choice",
                      text: "Proceed?",
                      options: [{ id: "yes", label: "Yes" }],
                      multiSelect: false,
                      allowOther: false,
                    },
                  ],
                },
              });
            } else if (
              role.includes("planner") ||
              role.includes("reviewer") ||
              (!hold && role.includes("worker"))
            )
              await finish(ctx.threadId);
          },
          async resolve(interaction, resolution) {
            await session.resolve(interaction, resolution);
            await finish(ctx.threadId);
          },
          async interrupt(target) {
            await session.interrupt(target);
            await output(ctx, { ...end, outcome: "interrupted" });
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const launch = () =>
    startDaemon({
      config: readConfig({
        ACE_HOME: join(home, "daemon"),
        ACE_PORT: "0",
        ACE_LOG_LEVEL: "silent",
      }),
      engine: { registry, preferences: { continueAfterRestart: false } },
      modelInstances: [],
      workspaceActions: { forgeRunner: forge.runner },
      agentControl: { policy: { maxConcurrent: options.hostCapacity ?? 4 } },
    });
  daemon = await launch();
  const workspace = daemon.store.createWorkspace(repo, "Deck repo");
  const model = { provider: "codex", model: "scripted", tier: "normal", cost: 0, quota: 1 };
  const spec = ConductorSpec.parse({
    rootAgentId: randomUUID(),
    workspaceId: workspace,
    goal: "Implement the cards",
    repositoryRules: "Synthetic scripted provider; no CLI prompts",
    constraints: {
      providers: ["codex"],
      models: ["scripted"],
      accounts: ["local.codex"],
      budget: 100,
      maxParallel: options.parallel ?? 4,
      deadline: null,
      stallAfterMs: options.stallAfterMs ?? 60000,
    },
    policies: {
      planApproval: options.planApproval ?? "auto",
      merge: options.prOnly ? "PR-only" : "auto-after-verification",
      maxFixRounds: 1,
      roles: { planner: [model], worker: [model], reviewer: [model], integrator: [model] },
    },
  });
  const runId = `run-${randomUUID()}`;
  let client: Client;
  const changes: ConductorRunView[] = [];
  async function connect() {
    client = new Client(daemon.url);
    await once(client.socket, "open");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("deck-client"),
      token: readFileSync(daemon.tokenPath, "utf8").trim(),
    });
    const welcome = await client.next();
    if (welcome.type !== "welcome") throw new Error("Daemon did not authenticate");
    client.socket.on("message", (data) => {
      const message = ServerMessage.parse(JSON.parse(data.toString()));
      if (message.type === "conductor.changed") changes.push(message.run);
    });
  }
  await connect();
  function request(
    message: import("@ace/protocol").ClientMessage,
    matches: (reply: ServerMessage) => boolean,
  ): Promise<ServerMessage> {
    return new Promise((resolve) => {
      const receive = (data: import("ws").RawData) => {
        const reply = ServerMessage.parse(JSON.parse(data.toString()));
        if (matches(reply)) {
          client.socket.off("message", receive);
          resolve(reply);
        }
      };
      client.socket.on("message", receive);
      client.send(message);
    });
  }
  async function read() {
    const requestId = randomUUID();
    const reply = await request(
      { type: "conductor.request", requestId, operation: { op: "get", runId } },
      (response) => "requestId" in response && response.requestId === requestId,
    );
    if (reply.type !== "conductor.result" || !reply.ok || !reply.run)
      throw new Error("Deck read failed");
    return reply.run;
  }
  async function subscribe() {
    const requestId = randomUUID();
    const reply = await request(
      {
        type: "conductor.request",
        requestId,
        operation: { op: "subscribe", runId, subscriptionId: randomUUID() },
      },
      (response) => "requestId" in response && response.requestId === requestId,
    );
    if (reply.type !== "conductor.result" || !reply.ok || !reply.run)
      throw new Error("Deck subscription failed");
    changes.push(reply.run);
  }
  async function commands(payload: CommandPayload) {
    const command = Command.parse({ id: randomUUID(), deviceId: "deck-client", payload });
    const reply = await request(
      { type: "command", command },
      (response) => response.type === "commandResult" && response.commandId === command.id,
    );
    if (reply.type !== "commandResult") throw new Error("Command result missing");
    return reply;
  }
  const startRun = () => commands({ type: "conductor.start", runId, spec });
  cleanups.push(async () => {
    await client.close();
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    read,
    subscribe,
    changes,
    runId,
    spec,
    repo,
    original,
    sends,
    contexts,
    forge,
    commands,
    startRun,
    finish,
    release: () => {
      hold = false;
    },
    get daemon() {
      return daemon;
    },
    async restart() {
      await client.close();
      await daemon.close();
      contexts.clear();
      daemon = await launch();
      await connect();
    },
  };
}
