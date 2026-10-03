import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import type { SessionContext } from "@ace/engine-api";
import type { Fact } from "@ace/core";
import {
  Capabilities,
  type McpAttribution,
  type ThreadId,
  type DelegationPolicy,
  type Event,
} from "@ace/protocol";
import { Store, Engine, AdapterRegistry, DelegationService } from "@ace/daemon";
import { ManualClock, scriptFrames, start, end } from "../engine/test-support.ts";

const homes: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
export function setup(
  policy: Partial<DelegationPolicy> = {},
  path?: string,
  answerable = false,
  opening?: { entered(): void; ready: Promise<void> },
  _followup = false,
  accounts?: import("@ace/accounts").AccountRegistry,
  capacity?: number,
) {
  const home = path ? join(path, "..") : mkdtempSync(join(tmpdir(), "ace-control-"));
  if (!path) homes.push(home);
  const dbPath = path ?? join(home, "events.sqlite");
  const store = new Store(dbPath);
  const workspace = store.createWorkspace(home, "workspace");
  const clock = new ManualClock();
  const frames = scriptFrames();
  let admitting = true;
  let nativeSequence = 0;
  const nativeHistories = new Map<string, string[]>();
  const contexts = new Map<ThreadId, SessionContext>();
  const registry = new AdapterRegistry();
  const capabilities = Capabilities.parse({
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
  });
  for (const provider of ["codex", "claude"] as const) {
    const adapter = createScriptedAdapter({
      provider,
      capabilities,
      nativeSessionId: `unused-${provider}`,
      createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
      steps:
        provider === "codex" && answerable
          ? [
              {
                on: "send",
                frames: [
                  frames.frame(start, {
                    type: "interaction.opened",
                    agent: "root",
                    interaction: "question",
                    blocking: true,
                    request: {
                      kind: "question",
                      questions: [
                        {
                          id: "choice",
                          text: "Which?",
                          options: [{ id: "safe", label: "Safe" }],
                          multiSelect: false,
                          allowOther: false,
                        },
                      ],
                    },
                  }),
                ],
              },
              { on: "resolve", frames: [] },
            ]
          : provider === "codex"
            ? Array.from({ length: 10 }, () => ({
                on: "send" as const,
                frames: [frames.frame(start, end)],
              }))
            : [],
    });
    registry.register(
      {
        ...adapter,
        async openSession(ctx) {
          contexts.set(ctx.threadId, ctx);
          if (provider === "claude" && opening) {
            opening.entered();
            await opening.ready;
          }
          const session = await adapter.openSession(ctx);
          const nativeSessionId =
            ctx.resume?.nativeSessionId ?? `native-${provider}-${++nativeSequence}`;
          const history = nativeHistories.get(nativeSessionId) ?? [];
          nativeHistories.set(nativeSessionId, history);
          return {
            ...session,
            nativeSessionId,
            async send(input, delivery) {
              await session.send(input, delivery);
              history.push(...input.flatMap((part) => (part.type === "text" ? [part.text] : [])));
              if (provider === "claude") ctx.onFrame(frames.frame(start));
            },
            async interrupt(target) {
              await session.interrupt(target);
              if (provider === "claude")
                ctx.onFrame(frames.frame({ ...end, outcome: "interrupted" }));
            },
            close: async () => {
              ctx.onExit({ deliberate: true });
            },
          };
        },
      },
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
  }
  const errors: unknown[] = [];
  const engine = new Engine(store, {
    registry,
    clock,
    idleMs: 100000,
    silenceMs: 100000,
    onError: (error) => errors.push(error),
  });
  let service = new DelegationService({
    store,
    engine,
    clock,
    id: randomUUID,
    policy,
    ...(capacity === undefined ? {} : { journalCapacity: capacity }),
    ...(accounts ? { accounts } : {}),
    admitsWork: () => admitting,
    onError: (error) => errors.push(error),
  });
  const events: Event[] = [];
  const unsubscribe = store.subscribe((batch) => events.push(...batch));
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    service.close();
    unsubscribe();
    await engine.close();
    store.close();
  }
  cleanup.push(close);
  function caller(threadId: ThreadId): McpAttribution {
    const agentId = store.getThread(threadId)?.rootAgentId;
    if (!agentId) throw new Error("Root not materialized");
    return { sessionId: "test-lease", threadId, agentId };
  }
  async function parent() {
    const result = service.command(randomUUID(), {
      type: "thread.create",
      workspaceId: workspace,
      provider: "codex",
      input: [{ type: "text", text: "plan" }],
    });
    if (!result.ok || !result.threadId) throw new Error("Creation failed");
    await engine.flush();
    return caller(result.threadId);
  }
  function delegate(identity: McpAttribution, requestId: string, wait = false) {
    return service.delegate(identity, {
      requestId,
      task: "Implement safely",
      role: "implementer",
      provider: "claude",
      model: "chosen-model",
      options: { effort: "high" },
      wait,
      estimatedLoad: 0,
    });
  }
  async function emit(thread: ThreadId, ...facts: Fact[]) {
    const ctx = contexts.get(thread);
    if (!ctx) throw new Error("Missing native session");
    ctx.onFrame(frames.frame(...facts));
    await engine.flush();
  }
  async function complete(thread: ThreadId, text: string) {
    await emit(
      thread,
      {
        type: "item.upsert",
        agent: "root",
        item: `result-${thread}`,
        draft: {
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text }],
          complete: true,
        },
      },
      end,
    );
  }
  return {
    home,
    nativeHistories,
    closeAdmission: () => {
      admitting = false;
    },
    openAdmission: () => {
      admitting = true;
    },
    registry,
    frames,
    dbPath,
    store,
    engine,
    clock,
    contexts,
    events,
    errors,
    caller,
    parent,
    delegate,
    emit,
    complete,
    close,
    get service() {
      return service;
    },
    restartOwner() {
      service.close();
      service = new DelegationService({
        store,
        engine,
        clock,
        id: randomUUID,
        policy,
        ...(capacity === undefined ? {} : { journalCapacity: capacity }),
        ...(accounts ? { accounts } : {}),
        admitsWork: () => admitting,
        onError: (error) => errors.push(error),
      });
    },
  };
}
export function wakes(events: Event[], thread: ThreadId) {
  return events.filter(
    (event) =>
      event.threadId === thread &&
      event.payload.type === "run.started" &&
      event.payload.run.trigger === "subagent_result",
  );
}
