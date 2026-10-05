import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Capabilities,
  Command,
  ThreadId,
  type CommandPayload,
  type ContentPart,
  type ExecutionSelection,
  type ForkPoint,
  type ProviderKind,
} from "@ace/protocol";
import type { Fact } from "@ace/core";
import type { ProviderAdapter, SessionContext } from "@ace/engine-api";
import { Engine, AdapterRegistry, Store, type EngineOptions } from "@ace/daemon";
import { ManualClock, scriptFrames } from "./test-support.ts";
import type { TransitionIO } from "./transitions.ts";

export function transitionHarness(
  options: {
    native?: boolean;
    cursorBackend?: import("@ace/engine-api").ProviderBackend;
    forkPoints?: ("turn" | "item" | "end")[];
    outcome?: "completed" | "failed" | "interrupted";
    limited?: boolean;
    io?: TransitionIO;
    recovery?: EngineOptions["recovery"];
    preferences?: EngineOptions["preferences"];
    onProviderDiagnostic?: EngineOptions["onProviderDiagnostic"];
    configure?: boolean;
    closeFails?: boolean;
    configureFails?: boolean;
    maxActiveThreads?: number;
    beforeFork?(context: SessionContext): Promise<void>;
    providerEnabled?: EngineOptions["providerEnabled"];
    prepareWorkspace?(id: ThreadId): Promise<string>;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "ace-transition-"));
  let store = new Store(join(home, "events.sqlite"));
  const workspace = store.createWorkspace(home, "Workspace");
  const clock = new ManualClock();
  const frames = scriptFrames();
  const registry = new AdapterRegistry();
  const histories = new Map<string, { text: string; turn: string }[]>();
  const sessions: {
    context: SessionContext;
    nativeId: string;
    selection: ExecutionSelection;
    closed: boolean;
  }[] = [];
  const inputs: {
    provider: ProviderKind;
    nativeId: string;
    text: string;
    model?: string | undefined;
    options: ExecutionSelection["options"];
  }[] = [];
  const held = new Set<ThreadId>();
  const emit = (id: ThreadId, ...facts: Fact[]) => {
    const session = sessions.findLast((entry) => entry.context.threadId === id && !entry.closed);
    if (!session) throw new Error("No fake provider session");
    session.context.onFrame(frames.frame(...facts));
  };
  let serial = 0;
  let closeFailed = false;
  for (const provider of ["codex", "claude", "cursor", "acp"] satisfies ProviderKind[]) {
    const adapter: ProviderAdapter = {
      provider,
      ...(provider === "cursor" && options.cursorBackend ? { backend: options.cursorBackend } : {}),
      ...(provider === "acp"
        ? {
            acceptsIdentity: (identity: SessionContext["acpIdentity"]) =>
              identity?.acpAgentId === "registered-agent",
          }
        : {}),
      capabilities: () =>
        Capabilities.parse({
          // These scripts implement the engine contract, not a native provider sandbox.
          permissions: {
            modes: ["read-only", "ask", "auto-review", "full-access"],
            nativeAutoReview: false,
            toolGate: true,
          },
          steer: true,
          interruptCascades: false,
          resume: true,
          fork: options.native ?? false,
          forkPoints: options.forkPoints ?? ["turn", "item"],
          sessionOptions: true,
          subagentTranscripts: true,
          backgroundTaskControl: true,
          backgroundVisibility: "full",
          planMode: true,
          tokenUsage: true,
          imageInput: true,
          rewindFiles: false,
        }),
      createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
      async openSession(context) {
        if (context.fork) await options.beforeFork?.(context);
        const nativeId =
          context.resume?.nativeSessionId ??
          `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;
        if (context.fork) {
          const source = histories.get(context.fork.nativeSessionId);
          if (!source) throw new Error("Unknown native source");
          const at =
            context.fork.point.type === "end"
              ? source.length - 1
              : source.findIndex(
                  (entry) =>
                    entry.turn === context.fork?.point.nativeId ||
                    `item-${entry.turn}` === context.fork?.point.nativeId,
                );
          if (at < 0) throw new Error("Unknown native boundary");
          histories.set(nativeId, source.slice(0, at + 1));
        }
        if (!histories.has(nativeId)) histories.set(nativeId, []);
        const entry: (typeof sessions)[number] = {
          context,
          nativeId,
          closed: false,
          selection: {
            provider,
            model: context.model,
            instanceId: context.instanceId ?? context.acpIdentity?.instanceId ?? "account-a",
            options: context.options ?? {},
          },
        };
        sessions.push(entry);
        return {
          nativeSessionId: nativeId,
          ...(provider === "cursor" && options.cursorBackend
            ? { backend: options.cursorBackend }
            : {}),
          instanceId: entry.selection.instanceId ?? "account-a",
          ...(options.configure === false
            ? {}
            : {
                configure: async (selection: ExecutionSelection) => {
                  if (options.configureFails) throw new Error("Provider configuration failed");
                  entry.selection = selection;
                },
              }),
          async send(parts: ContentPart[]) {
            if (entry.closed) throw new Error("Session is closed");
            const text = parts
              .map((part) => (part.type === "text" ? part.text : "attachment"))
              .join("\n");
            inputs.push({
              provider,
              nativeId,
              text,
              model: entry.selection.model,
              options: entry.selection.options,
            });
            const history = histories.get(nativeId);
            if (!history) throw new Error("Missing fake history");
            const turn = `turn-${++serial}`;
            const previous = history.map((item) => item.text).join("|");
            history.push({ text, turn });
            emit(
              context.threadId,
              { type: "turn.started", agent: "root", nativeTurnId: turn, trigger: "user" },
              {
                type: "item.upsert",
                agent: "root",
                item: turn,
                draft: {
                  type: "message",
                  role: "assistant",
                  complete: true,
                  nativeId: `item-${turn}`,
                  parts: [{ type: "text", text: `Prior context: ${previous}; answer: ${text}` }],
                },
              },
            );
            if (!held.has(context.threadId)) {
              emit(context.threadId, {
                type: "turn.ended",
                agent: "root",
                nativeTurnId: turn,
                outcome: options.outcome ?? "completed",
              });
              if (options.limited)
                emit(context.threadId, {
                  type: "retry",
                  agent: "root",
                  on: "rate_limit",
                  message: "Quota exhausted",
                });
            }
          },
          interrupt: async () => {},
          resolve: async () => {},
          stopTask: async () => {},
          close: async () => {
            if (options.closeFails && !closeFailed) {
              closeFailed = true;
              throw new Error("Provider close failed");
            }
            entry.closed = true;
          },
        };
      },
    };
    registry.register(adapter, { installed: true, auth: "logged_in", loginHint: "fake" });
  }
  const errors: unknown[] = [];
  const engineOptions = {
    ...(options.providerEnabled ? { providerEnabled: options.providerEnabled } : {}),
    registry,
    clock,
    onError: (error: unknown) => errors.push(error),
    ...(options.onProviderDiagnostic ? { onProviderDiagnostic: options.onProviderDiagnostic } : {}),
    ...(options.maxActiveThreads ? { limits: { maxActiveThreads: options.maxActiveThreads } } : {}),
    ...(options.io ? { transitions: options.io } : {}),
    ...(options.prepareWorkspace ? { prepareWorkspace: options.prepareWorkspace } : {}),
    ...(options.recovery ? { recovery: options.recovery } : {}),
    ...(options.preferences ? { preferences: options.preferences } : {}),
  };
  let engine = new Engine(store, engineOptions);
  function command(payload: CommandPayload, commandId = `command-${++serial}`) {
    const value = Command.parse({ id: commandId, deviceId: "device", payload });
    return store.recordCommand(value.id, value.deviceId, () => engine.handler.handle(value, store));
  }
  async function create() {
    const existing = new Set(store.listThreads().map((thread) => thread.id));
    const result = command({
      type: "thread.create",
      workspaceId: workspace,
      provider: "codex",
      model: "model-a",
      input: [{ type: "text", text: "source history" }],
    });
    if (!result.ok) throw new Error(result.error);
    await engine.flush();
    const thread = store.listThreads().find((candidate) => !existing.has(candidate.id));
    if (!thread) throw new Error("No created thread");
    return thread.id;
  }
  async function fork(
    id: ThreadId,
    point: ForkPoint = { type: "turn", runId: finishedRun(id).id },
  ) {
    const result = command({
      type: "thread.fork",
      threadId: id,
      point,
      input: "continue fork",
      budgetBytes: 4096,
    });
    if (!result.ok || !result.forkThreadId)
      throw new Error(result.error ?? "Fork did not return an ID");
    await engine.flush();
    return result.forkThreadId;
  }
  function finishedRun(id: ThreadId) {
    // Snapshot dictionaries have no chronological ordering. Read the durable boundaries.
    let afterSeq = 0;
    let runId: string | undefined;
    for (let page = 0; page < 100; page++) {
      const events = store.readEvents({ afterSeq, threadId: id, limit: 100 });
      for (const event of events)
        if (event.payload.type === "run.ended") runId = event.payload.runId;
      const last = events.at(-1);
      if (!last) {
        const run = runId ? store.snapshotThread(id).runs[runId] : undefined;
        if (!run) throw new Error("No finished source run");
        return run;
      }
      afterSeq = last.seq;
    }
    throw new Error("Transition fixture history exceeds its bound");
  }
  return {
    home,
    get store() {
      return store;
    },
    workspace,
    registry,
    clock,
    sessions,
    inputs,
    histories,
    held,
    emit,
    command,
    create,
    fork,
    finishedRun,
    errors,
    get engine() {
      return engine;
    },
    async restart() {
      await engine.close();
      engine = new Engine(store, engineOptions);
    },
    async reopen() {
      await engine.close();
      await store.close();
      store = new Store(join(home, "events.sqlite"));
      engine = new Engine(store, engineOptions);
      await engine.ready();
    },
    async close() {
      await engine.close();
      await store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
