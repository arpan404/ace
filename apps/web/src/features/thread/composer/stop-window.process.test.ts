import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore, defaultLimits } from "@ace/client";
import { Engine, Store, AdapterRegistry } from "@ace/daemon";
import {
  createScriptedAdapter,
  type AdapterScript,
  type ScriptedAdapter,
  type ScriptedStep,
} from "@ace/adapter-testkit";
import { Command, Capabilities, type CommandPayload } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { stopFence } from "./stop-target.ts";

type Fact = ReturnType<ReturnType<AdapterScript["createTranslator"]>["translate"]>[number];
type Frame = NonNullable<ScriptedStep["frames"]>[number];
type SessionContext = Parameters<ScriptedAdapter["openSession"]>[0];
const start = { type: "turn.started", agent: "root", trigger: "user" } satisfies Fact;
const end = { type: "turn.ended", agent: "root", outcome: "completed" } satisfies Fact;

function scriptFrames() {
  const bundles = new Map<string, Fact[]>();
  let seq = 0;
  return {
    frame(...facts: Fact[]): Frame {
      const channel = `facts-${++seq}`;
      bundles.set(channel, facts);
      return { seq, t: seq, dir: "recv", channel, data: { scripted: true } };
    },
    translate(frame: Frame): Fact[] {
      return structuredClone(bundles.get(frame.channel) ?? []);
    },
  };
}

function harness(steps: ScriptedStep[], frames: ReturnType<typeof scriptFrames>) {
  const home = mkdtempSync(join(tmpdir(), "ace-stop-window-"));
  const store = new Store(join(home, "events.sqlite"), undefined, { now: () => 1000 });
  const workspace = store.createWorkspace(home, "Stop window");
  const contexts: SessionContext[] = [];
  const adapter = createScriptedAdapter({
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
      imageInput: true,
      rewindFiles: false,
    }),
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
    steps,
  });
  const registry = new AdapterRegistry();
  registry.register(
    {
      ...adapter,
      async openSession(context) {
        contexts.push(context);
        return adapter.openSession(context);
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const engine = new Engine(store, {
    registry,
    clock: { now: () => 1000, setTimer: () => () => {} },
  });
  let serial = 0;
  const command = (payload: CommandPayload) => {
    const value = Command.parse({
      id: `stop-command-${++serial}`,
      deviceId: "stop-reader",
      payload,
    });
    return store.recordCommand(value.id, value.deviceId, () => engine.handler.handle(value, store));
  };
  return {
    store,
    workspace,
    engine,
    adapter,
    contexts,
    command,
    async create() {
      const result = command({
        type: "thread.create",
        workspaceId: workspace,
        provider: "codex",
        model: "model",
        input: [{ type: "text", text: "first" }],
      });
      if (!result.ok || !result.threadId) throw new Error("Thread creation failed");
      await engine.flush();
      return result.threadId;
    },
    async close() {
      await engine.close();
      await store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

test("Stop after a child-only 200-item reload stays fenced to the original root turn", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start)] },
      { on: "send", frames: [frames.frame(start)] },
    ],
    frames,
  );
  cleanups.push(h.close);
  const id = await h.create();
  h.contexts[0]?.onFrame(
    frames.frame(
      {
        type: "agent.seen",
        agent: "child",
        parent: "root",
        origin: "provider_subagent",
        fidelity: "full",
        native: { provider: "codex" },
        cwd: "/workspace",
      },
      { type: "turn.started", agent: "child", trigger: "spawn" },
      ...Array.from({ length: 205 }, (_, index) => ({
        type: "item.upsert" as const,
        agent: "child",
        item: `child-${index}`,
        draft: {
          type: "message" as const,
          role: "assistant" as const,
          complete: true,
          parts: [{ type: "text" as const, text: `Child output ${index}` }],
        },
      })),
    ),
  );
  await h.engine.flush();
  const snapshot = h.store.snapshotThread(id);
  expect(snapshot.itemOrder).toHaveLength(200);
  expect(
    Object.values(snapshot.items).every((item) => item.agentId !== snapshot.thread.rootAgentId),
  ).toBe(true);
  const reader = new ThreadStore(defaultLimits);
  reader.snapshot(snapshot);
  const fence = stopFence(reader);
  expect(fence && "runId" in fence ? fence.runId : undefined).toBe(snapshot.thread.live?.rootRunId);
  expect(fence && "runId" in fence ? fence.runId : undefined).toBeDefined();
  h.contexts[0]?.onFrame(
    frames.frame(end, { type: "turn.ended", agent: "child", outcome: "completed" }),
  );
  await h.engine.flush();
  expect(
    h.command({
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "New root turn" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(
    h.command({ type: "thread.interrupt", threadId: id, cascade: true, ...fence }),
  ).toMatchObject({ ok: false, error: "stale_interrupt" });
  expect(h.store.getThread(id)?.status.state).toBe("working");
  expect(h.adapter.commands.filter((command) => command.type === "interrupt")).toEqual([]);
});

test("a pre-start Stop pauses its admitted input but refuses after newer work starts", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  cleanups.push(h.close);
  const receipt = h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "codex",
    input: [{ type: "text", text: "Pending startup" }],
  });
  const id = receipt.threadId;
  if (!id) throw new Error("No thread");
  const reader = new ThreadStore(defaultLimits);
  reader.snapshot(h.store.snapshotThread(id));
  const fence = stopFence(reader);
  expect(fence && "beforeSeq" in fence ? fence.beforeSeq : undefined).toBeDefined();
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true, ...fence }).ok).toBe(
    true,
  );
  await h.engine.flush();
  expect(h.contexts).toHaveLength(0);
  expect(h.engine.queue(id).messages).toHaveLength(1);
  expect(
    h.command({ type: "queue.resume", threadId: id, expectedRevision: h.engine.queue(id).revision })
      .ok,
  ).toBe(true);
  await h.engine.flush();
  expect(
    h.command({ type: "thread.interrupt", threadId: id, cascade: true, ...fence }),
  ).toMatchObject({ ok: false, error: "stale_interrupt" });
  expect(h.store.getThread(id)?.status.state).toBe("working");
  expect(h.adapter.commands.filter((command) => command.type === "interrupt")).toEqual([]);
});
