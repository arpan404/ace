import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import { copyScriptedFrame } from "./scripted-frames.ts";
import type { Key } from "@ace/core";
import type { Frame, ProviderAdapter, ProviderSession, SessionContext } from "@ace/engine-api";
import type { Capabilities, ContentPart, InteractionResolution, ProviderKind } from "@ace/protocol";

export type ScriptedCommand =
  | { type: "send"; input: ContentPart[]; delivery: "steer" | "queue" }
  | { type: "interrupt"; target: { agent?: Key; cascade: boolean } }
  | { type: "resolve"; interaction: Key; resolution: InteractionResolution }
  | { type: "stopTask"; task: Key }
  | { type: "close"; reason: "idle" | "user" | "shutdown" };

export interface ScriptedStep {
  /** Steps run on open or the next matching command, awaiting frame admission. No real clock or CLI. */
  on: "open" | ScriptedCommand["type"];
  frames?: readonly Frame[];
  exit?: { deliberate: boolean; message?: string };
}
export interface AdapterScript {
  provider: ProviderKind;
  capabilities: Capabilities;
  createTranslator: ProviderAdapter["createTranslator"];
  nativeSessionId?: string;
  steps: readonly ScriptedStep[];
}
export interface ScriptedSession extends ProviderSession {
  readonly commands: ScriptedCommand[];
}
export interface ScriptedAdapter extends ProviderAdapter {
  /** Commands across all sessions, in receipt order. Inputs are copied on receipt. */
  readonly commands: ScriptedCommand[];
  readonly sessions: ScriptedSession[];
}

/** Each opened session gets its own script cursor and command log. */
export function createScriptedAdapter(script: AdapterScript): ScriptedAdapter {
  const steps = script.steps.map((step) => ({
    on: step.on,
    ...(step.frames ? { frames: step.frames.map(copyScriptedFrame) } : {}),
    ...(step.exit ? { exit: structuredClone(step.exit) } : {}),
  }));
  const capabilities = structuredClone(script.capabilities);
  if (!capabilities.permissions) {
    const permissionModes = capabilities.permissionModes ?? nativePermissionModes(script.provider);
    capabilities.permissionModes ??= permissionModes;
    capabilities.permissions = {
      modes: permissionModes.map((entry) => entry.id),
      permissionModes,
      nativeAutoReview: false,
      toolGate: true,
    };
  }
  const commands: ScriptedCommand[] = [];
  const sessions: ScriptedSession[] = [];
  return {
    provider: script.provider,
    capabilities: () => structuredClone(capabilities),
    createTranslator: (init) => script.createTranslator(init),
    commands,
    sessions,
    async openSession(ctx: SessionContext): Promise<ScriptedSession> {
      ctx.signal.throwIfAborted();
      let cursor = 0;
      let closed = false;
      const received: ScriptedCommand[] = [];
      let emission = Promise.resolve();
      function exit(value: { deliberate: boolean; message?: string }): void {
        if (closed) return;
        closed = true;
        ctx.signal.removeEventListener("abort", abort);
        ctx.onExit(structuredClone(value));
      }
      function abort(): void {
        exit({ deliberate: true, message: "aborted" });
      }
      async function emit(on: ScriptedStep["on"]): Promise<void> {
        const step = steps[cursor];
        if (!step) return;
        if (step.on !== on) {
          if (on === "open") return;
          throw new Error(`script step ${cursor} expected ${step.on}, got ${on}`);
        }
        cursor++;
        for (const frame of step.frames ?? []) {
          if (closed) break;
          await ctx.onFrame(copyScriptedFrame(frame));
        }
        if (step.exit && !closed) exit(step.exit);
      }
      function record(command: ScriptedCommand): void {
        if (closed) throw new Error("scripted session is closed");
        received.push(structuredClone(command));
        commands.push(structuredClone(command));
      }
      function enqueue(operation: () => void | Promise<void>): Promise<void> {
        const pending = emission.then(operation);
        emission = pending.catch(() => {});
        return pending;
      }
      async function receive(command: ScriptedCommand): Promise<void> {
        record(command);
        await enqueue(async () => {
          if (closed) throw new Error("scripted session is closed");
          await emit(command.type);
        });
      }
      const session: ScriptedSession = {
        nativeSessionId:
          ctx.resume?.nativeSessionId ?? script.nativeSessionId ?? "scripted-session",
        commands: received,
        async send(input, delivery) {
          await receive({ type: "send", input, delivery });
        },
        async interrupt(target) {
          await receive({ type: "interrupt", target });
        },
        async resolve(interaction, resolution) {
          await receive({ type: "resolve", interaction, resolution });
        },
        async stopTask(task) {
          await receive({ type: "stopTask", task });
        },
        async close(reason) {
          if (closed) return;
          record({ type: "close", reason });
          await enqueue(async () => {
            try {
              if (!closed) await emit("close");
            } finally {
              exit({ deliberate: true });
            }
          });
        },
      };
      sessions.push(session);
      ctx.signal.addEventListener("abort", abort, { once: true });
      try {
        await emit("open");
        return session;
      } catch (error) {
        closed = true;
        ctx.signal.removeEventListener("abort", abort);
        sessions.splice(sessions.indexOf(session), 1);
        throw error;
      }
    },
  };
}
