/**
 * One side of machine-link.ts, run as its own Bun process in a temporary home (startBenchDaemon, @ace/perf-kit/daemon).
 * MACHINE_LINK_ROLE=target hosts the remote child: it listens for paired devices over TLS and
 * lets paired machines' agents operate it. MACHINE_LINK_ROLE=source is the machine whose agent
 * delegates there; its calls to the target go through a wrapper that records each one. Both run
 * scripted providers on the daemon's own engine, so no provider CLI runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AdapterRegistry, readConfig, readHistoryInstances, startDaemon } from "@ace/daemon";
import type { Fact } from "@ace/core";
import type { Frame, ProviderAdapter, SessionContext } from "@ace/engine-api";
import { ProviderPayload } from "@ace/provider-kit/payload";
import {
  Capabilities,
  DeviceId,
  ThreadId,
  type AgentControlOperation,
  type McpAttribution,
} from "@ace/protocol";
import { machineRequest, type MachineTransport } from "../src/machines/transport.ts";
import { Profiles } from "../src/cli/profiles.ts";
import { scriptedModelInstance, seedScriptedModels } from "../src/testing/models.ts";

const role = z.enum(["target", "source"]).parse(process.env.MACHINE_LINK_ROLE);
const config = readConfig();

const FrameData = z.object({ kind: z.enum(["start", "end", "answer"]) });
const facts = (kind: z.infer<typeof FrameData>["kind"]): Fact[] => {
  if (kind === "start") return [{ type: "turn.started", agent: "root", trigger: "user" }];
  const ended: Fact = { type: "turn.ended", agent: "root", outcome: "completed" };
  if (kind === "end") return [ended];
  return [
    {
      type: "item.upsert",
      agent: "root",
      item: `answer-${++answers}`,
      draft: {
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text: "Three pull requests are open; two wait on review." }],
        complete: true,
      },
    },
    ended,
  ];
};
let answers = 0;
let seq = 0;
const frame = (kind: z.infer<typeof FrameData>["kind"]): Frame => {
  const payload = new ProviderPayload(JSON.stringify({ kind }));
  return { seq: ++seq, t: 0, dir: "recv", channel: "machine", data: payload.data, payload };
};
const capabilities = Capabilities.parse({
  permissions: { modes: ["auto-review", "full-access"], nativeAutoReview: false, toolGate: true },
  steer: false,
  interruptCascades: false,
  resume: true,
  fork: false,
  subagentTranscripts: true,
  backgroundTaskControl: true,
  backgroundVisibility: "full",
  planMode: false,
  tokenUsage: true,
  imageInput: false,
  rewindFiles: false,
  launchOptions: ["effort", "serviceTier"],
  sessionOptions: true,
});
const sessions = new Map<string, SessionContext>();
/**
 * Codex answers at once (the delegating parent); Claude starts and keeps working until the
 * parent process asks this side to finish it (the remote child).
 */
const adapter = (provider: "codex" | "claude"): ProviderAdapter => ({
  provider,
  capabilities: () => capabilities,
  createTranslator: () => ({
    tick: () => [],
    translate: (input) => facts(FrameData.parse(input.data).kind),
  }),
  async openSession(context) {
    sessions.set(context.threadId, context);
    return {
      nativeSessionId: `machine-${provider}-${context.threadId}`,
      async send() {
        await context.onFrame(frame("start"));
        if (provider === "codex") await context.onFrame(frame("end"));
      },
      async interrupt() {},
      async resolve() {},
      async stopTask() {},
      async close() {
        sessions.delete(context.threadId);
        context.onExit({ deliberate: true });
      },
    };
  },
});
const registry = new AdapterRegistry();
for (const provider of ["codex", "claude"] as const)
  registry.register(adapter(provider), { installed: true, auth: "logged_in", loginHint: "unused" });

/**
 * A status answer, read leniently: it comes from the other daemon. Only whether it reports a
 * finished thread matters here.
 */
const StatusAnswer = z.object({
  threads: z.array(
    z.object({ status: z.object({ state: z.string() }).passthrough() }).passthrough(),
  ),
});
const reportsDone = (answer: unknown) =>
  StatusAnswer.safeParse(answer).data?.threads.some((thread) => thread.status.state === "done") ??
  false;
/**
 * Every call the source made to the target: its operation, when it started, how long it took,
 * and for status calls whether the answer reported the child finished.
 */
const calls: { op: string; at: number; ms: number; ok: boolean; done: boolean }[] = [];
const counted: MachineTransport = async (profile, body, options) => {
  const started = performance.now();
  try {
    const answer = await machineRequest(profile, body, options);
    calls.push({
      op: body.call.op,
      at: started,
      ms: performance.now() - started,
      ok: true,
      done: body.call.op === "status" && reportsDone(answer),
    });
    return answer;
  } catch (error) {
    calls.push({
      op: body.call.op,
      at: started,
      ms: performance.now() - started,
      ok: false,
      done: false,
    });
    throw error;
  }
};

const daemon = await startDaemon({
  config,
  engine: { registry },
  modelInstances: [],
  history: { instances: readHistoryInstances({ ACE_HISTORY_INSTANCES: "[]" }) },
  notificationChannels: {},
  providerStatus: {
    env: { PATH: "" },
    cursorSdk: async () => ({ installed: false, auth: "unknown", loginHint: "unused" }),
  },
  // The default poll interval: the call rate a person's machines actually see.
  ...(role === "source" ? { machines: { transport: counted } } : {}),
});
await daemon.settings.set("access.defaultMode", "full-access", { kind: "global" });
for (const provider of ["codex", "claude"] as const)
  await seedScriptedModels(daemon.models, scriptedModelInstance(provider, config.dataDir));
if (role === "target") {
  daemon.store.createWorkspace(config.dataDir, "project");
  await daemon.settings.set("host.displayName", "Studio", { kind: "global" });
  await daemon.settings.set("remote.agentAccess", "operate", { kind: "global" });
}

const Request = z.discriminatedUnion("op", [
  z.object({
    id: z.number(),
    op: z.literal("pair"),
    origin: z.string(),
    fingerprint: z.string(),
    deviceId: DeviceId,
    token: z.string(),
  }),
  z.object({ id: z.number(), op: z.literal("delegate") }),
  z.object({ id: z.number(), op: z.literal("finish"), thread: z.string() }),
  z.object({ id: z.number(), op: z.literal("state"), thread: z.string() }),
  z.object({ id: z.number(), op: z.literal("calls") }),
  z.object({ id: z.number(), op: z.literal("close") }),
]);
let caller: McpAttribution | undefined;
const call = (operation: AgentControlOperation) => {
  const controls = daemon.agentControl;
  if (!controls || !caller) throw new Error("Agent control unavailable");
  return controls.port.execute(caller, operation, new AbortController().signal);
};
let queue = Promise.resolve();
// The bench that started this process is gone (it crashed or was killed): stop with it rather
// than keep a daemon running in a temporary home nobody will remove.
process.once("disconnect", () => process.exit(0));
process.on("message", (input: unknown) => {
  queue = queue
    .then(async () => {
      const request = Request.parse(input);
      const reply = (data: Record<string, unknown>) => {
        process.send?.({ id: request.id, ...data });
      };
      if (request.op === "close") {
        await daemon.close();
        process.disconnect?.();
        return;
      }
      if (request.op === "pair") {
        const profiles = new Profiles(config.dataDir);
        profiles.add({
          name: "studio",
          origin: request.origin,
          fingerprint: request.fingerprint,
          deviceId: request.deviceId,
          token: request.token,
        });
        profiles.close();
        // Agent control loads in the background once the daemon has started.
        for (let tries = 0; !daemon.agentControl && tries < 600; tries++)
          await new Promise((resolve) => setTimeout(resolve, 50));
        const controls = daemon.agentControl;
        const engine = daemon.engine;
        if (!controls || !engine) throw new Error("Agent control unavailable");
        const workspace = daemon.store.createWorkspace(config.dataDir, "project");
        const parent = controls.delegations.command("create-parent", {
          type: "thread.create",
          workspaceId: workspace,
          provider: "codex",
          access: "full-access",
          input: [{ type: "text", text: "Review the open pull requests on the studio machine" }],
        });
        await engine.flush();
        const thread = parent.threadId ? daemon.store.getThread(parent.threadId) : undefined;
        if (!thread?.rootAgentId) throw new Error("Parent thread did not start");
        caller = { sessionId: "machine-link", threadId: thread.id, agentId: thread.rootAgentId };
        await call({ op: "machines" });
        return reply({});
      }
      if (request.op === "delegate") {
        const result = await call({
          op: "delegate_task",
          requestId: "review-on-studio",
          task: "Summarize the open pull requests",
          role: "Review-open-pull-requests",
          provider: "claude",
          machine: "studio",
          project: "project",
        });
        return reply({ result: JSON.parse(JSON.stringify(result)) });
      }
      if (request.op === "finish") {
        const context = sessions.get(request.thread);
        if (!context) throw new Error("Remote child has no session here");
        await context.onFrame(frame("answer"));
        await daemon.engine?.flush();
        return reply({});
      }
      if (request.op === "state") {
        const state = daemon.store.getThread(ThreadId.parse(request.thread))?.status.state;
        return reply({ state: state ?? "missing", children: sessions.size });
      }
      return reply({ calls, now: performance.now() });
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
      process.send?.({ error: String(error) });
    });
});

process.send?.({
  id: 0,
  endpoint: daemon.url,
  token: readFileSync(join(config.dataDir, "daemon-token"), "utf8"),
  remoteUrl: daemon.remoteUrl,
  fingerprint: daemon.fingerprint,
});
