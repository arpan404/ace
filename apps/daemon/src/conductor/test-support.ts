import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, readConfig } from "@ace/daemon";
import { once } from "node:events";
import { Client } from "../socket-test-support.ts";

import {
  Command,
  ConductorSpec,
  DeviceId,
  type CommandPayload,
  ThreadId,
  type ConductorPlan,
  type ConductorRunView,
  ServerMessage,
} from "@ace/protocol";
import { ManualClock } from "../engine/test-support.ts";
import { scriptedForge } from "./test-forge.ts";
import { deckProvider } from "./test-provider.ts";
import { git } from "./test-git.ts";
export { git } from "./test-git.ts";
const noop = () => {};

const cleanups: (() => Promise<void>)[] = [];
export async function closeDeckFixtures() {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
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
    auth?: "logged_in" | "logged_out" | "unknown";
    stallAfterMs?: number;
    longReview?: boolean;
    removeWorkerTree?: boolean;
    engineCapacity?: number;
    clock?: ManualClock;
    home?: string;
    recover?: boolean;
    crossProvider?: boolean;
    onSwitchClose?(thread: ThreadId): Promise<void>;
    onSend?(entry: { thread: ThreadId; text: string; cwd: string; resumed: boolean }): void;
  } = {},
) {
  const clock = options.clock ?? new ManualClock();
  const home = options.home ?? mkdtempSync(join(tmpdir(), "ace-deck-"));
  const repo = join(home, "repo");
  if (!options.recover) {
    mkdirSync(repo);
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.name", "Deck fixture");
    git(repo, "config", "user.email", "fixture@example.invalid");
    git(repo, "config", "commit.gpgSign", "false");
    git(repo, "commit", "--allow-empty", "-m", "base");
  }
  const original = git(repo, "rev-parse", "HEAD");
  const forge = scriptedForge();
  if (options.prOnly) {
    const remote = join(home, "remote.git");
    git(home, "init", "--bare", remote);
    git(repo, "remote", "add", "origin", "https://github.com/octo/ace.git");
    git(repo, "remote", "set-url", "--push", "origin", remote);
    git(repo, "push", "origin", "main");
  }
  const executionErrors: string[] = [];
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  const provider = deckProvider(options, home, () => daemon?.store);
  const { registry, sends, contexts, finish } = provider;
  let preparation: { entered(): void; wait: Promise<void> } | undefined;
  function holdPreparation() {
    let release = noop;
    let entered = noop;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    preparation = { entered, wait };
    return { reached, release };
  }
  const launch = () =>
    startDaemon({
      config: readConfig({
        ACE_HOME: join(home, "daemon"),
        ACE_PORT: "0",
        ACE_LOG_LEVEL: "silent",
      }),
      engine: {
        registry,
        idleMs: 10,
        clock,
        ...(options.engineCapacity ? { limits: { maxActiveThreads: options.engineCapacity } } : {}),
        recovery: {
          async preferences() {
            const barrier = preparation;
            preparation = undefined;
            if (barrier) {
              barrier.entered();
              await barrier.wait;
            }
            return {
              continueAfterRestart: false,
              followUpBehavior: "queue",
              limitPolicy: "manual",
            };
          },
        },
      },
      conductor: {
        onError: (error) =>
          executionErrors.push(error instanceof Error ? error.message : "unknown"),
      },
      modelInstances: [],
      workspaceActions: { forgeRunner: forge.runner },
      agentControl: { policy: { maxConcurrent: options.hostCapacity ?? 4 } },
    });
  daemon = await launch();
  const workspace = daemon.store.createWorkspace(repo, "Deck repo");
  const model = { provider: "codex", model: "scripted", tier: "normal", cost: 0, quota: 1 };
  const fixturePath = join(home, "fixture.json");
  const models = options.crossProvider ? [model, { ...model, provider: "claude" }] : [model];
  const spec = ConductorSpec.parse(
    options.recover
      ? z.object({ spec: ConductorSpec }).parse(JSON.parse(readFileSync(fixturePath, "utf8"))).spec
      : {
          rootAgentId: randomUUID(),
          workspaceId: workspace,
          goal: "Implement the cards",
          repositoryRules: "Synthetic scripted provider; no CLI prompts",
          constraints: {
            providers: options.crossProvider ? ["codex", "claude"] : ["codex"],
            models: ["scripted"],
            accounts: options.crossProvider ? ["local.codex", "local.claude"] : ["local.codex"],
            budget: 100,
            maxParallel: options.parallel ?? 4,
            deadline: null,
            stallAfterMs: options.stallAfterMs ?? 60000,
          },
          policies: {
            planApproval: options.planApproval ?? "auto",
            merge: options.prOnly ? "PR-only" : "auto-after-verification",
            maxFixRounds: 1,
            roles: { planner: [model], worker: models, reviewer: [model], integrator: [model] },
          },
        },
  );
  const runId = options.recover
    ? z.object({ runId: z.string() }).parse(JSON.parse(readFileSync(fixturePath, "utf8"))).runId
    : `run-${randomUUID()}`;
  if (!options.recover) writeFileSync(fixturePath, JSON.stringify({ runId, spec }));
  let client: Client;
  const changes: ConductorRunView[] = [];
  const listeners = new Set<(view: ConductorRunView) => void>();
  function changed(view: ConductorRunView) {
    changes.push(view);
    for (const listener of listeners) listener(view);
  }
  function waitFor(predicate: (view: ConductorRunView) => boolean): Promise<ConductorRunView> {
    const latest = changes.at(-1);
    if (latest && predicate(latest)) return Promise.resolve(latest);
    // Git subprocesses, SQLite and local socket delivery use real I/O; this is a
    // safety deadline for an event milestone, not a delay controlling progress.
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        listeners.delete(listener);
        reject(
          new Error(
            `Deck milestone timed out: ${JSON.stringify(changes.at(-1))}; effects: ${executionErrors.join(",")}`,
          ),
        );
      }, 20_000);
      const listener = (view: ConductorRunView) => {
        if (!predicate(view)) return;
        listeners.delete(listener);
        clearTimeout(timeout);
        resolve(view);
      };
      listeners.add(listener);
    });
  }
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
      if (message.type === "conductor.changed") changed(message.run);
    });
  }
  await connect();
  function request(
    message: import("@ace/protocol").ClientMessage,
    matches: (reply: ServerMessage) => boolean,
  ): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const socket = client.socket;
      const cleanup = () => {
        socket.off("message", receive);
        socket.off("close", closed);
        socket.off("error", failed);
      };
      const closed = (code: number) => {
        cleanup();
        reject(new Error(`Deck socket closed before reply: ${code}`));
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const receive = (data: import("ws").RawData) => {
        const reply = ServerMessage.parse(JSON.parse(data.toString()));
        if (matches(reply)) {
          cleanup();
          resolve(reply);
        }
      };
      socket.on("message", receive);
      socket.once("close", closed);
      socket.once("error", failed);
      if (socket.readyState !== socket.OPEN) closed(1006);
      else client.send(message);
    });
  }
  async function listRuns() {
    const requestId = randomUUID();
    const reply = await request(
      { type: "conductor.request", requestId, operation: { op: "list", limit: 16 } },
      (response) => "requestId" in response && response.requestId === requestId,
    );
    if (reply.type !== "conductor.result" || !reply.ok || !reply.runs)
      throw new Error("Deck list failed");
    return reply.runs;
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
    changed(reply.run);
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
    home,
    clock,
    async settle() {
      await daemon.engine?.flush();
      await daemon.conductor?.flush();
      await daemon.engine?.flush();
      await daemon.conductor?.flush();
    },
    async advance(ms = 1000) {
      await daemon.engine?.flush();
      await daemon.conductor?.flush();
      clock.advance(clock.now() + ms);
      await daemon.engine?.flush();
      await daemon.conductor?.flush();
    },
    waitFor,
    request,
    listRuns,
    read,
    holdPreparation,
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
    stream: provider.stream,
    beginStream: provider.beginStream,
    release: provider.release,
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
