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
  /** Steps run synchronously on open or the next matching command. No real clock or CLI. */
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
  const steps = structuredClone(script.steps);
  const capabilities = structuredClone(script.capabilities);
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
      function exit(value: { deliberate: boolean; message?: string }): void {
        if (closed) return;
        closed = true;
        ctx.signal.removeEventListener("abort", abort);
        ctx.onExit(structuredClone(value));
      }
      function abort(): void {
        exit({ deliberate: true, message: "aborted" });
      }
      function emit(on: ScriptedStep["on"]): void {
        const step = steps[cursor];
        if (!step) return;
        if (step.on !== on) {
          if (on === "open") return;
          throw new Error(`script step ${cursor} expected ${step.on}, got ${on}`);
        }
        cursor++;
        for (const frame of step.frames ?? []) {
          if (closed) break;
          ctx.onFrame(structuredClone(frame));
        }
        if (step.exit && !closed) exit(step.exit);
      }
      function receive(command: ScriptedCommand): void {
        if (closed) throw new Error("scripted session is closed");
        received.push(structuredClone(command));
        commands.push(structuredClone(command));
        emit(command.type);
      }
      const session: ScriptedSession = {
        nativeSessionId:
          ctx.resume?.nativeSessionId ?? script.nativeSessionId ?? "scripted-session",
        commands: received,
        async send(input, delivery) {
          receive({ type: "send", input, delivery });
        },
        async interrupt(target) {
          receive({ type: "interrupt", target });
        },
        async resolve(interaction, resolution) {
          receive({ type: "resolve", interaction, resolution });
        },
        async stopTask(task) {
          receive({ type: "stopTask", task });
        },
        async close(reason) {
          if (closed) return;
          receive({ type: "close", reason });
          exit({ deliberate: true });
        },
      };
      sessions.push(session);
      ctx.signal.addEventListener("abort", abort, { once: true });
      emit("open");
      return session;
    },
  };
}
