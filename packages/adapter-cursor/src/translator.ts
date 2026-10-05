import type { Fact, Key } from "@ace/core";
import type { Frame, Translator } from "@ace/engine-api";
import { ContentPart, type ThreadId } from "@ace/protocol";
import { z } from "zod";
import { boundedJson } from "@ace/provider-kit/ipc";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { Envelope, object, string, nativeIdentity, type CursorEnvelope } from "./contracts.ts";
import { Children } from "./children.ts";
import { Transcript } from "./transcript.ts";
import { ToolEvents } from "./tool-events.ts";
import { translateDelta } from "./delta-events.ts";

export interface CursorTranslatorOptions {
  threadId: ThreadId;
  rootKey: Key;
  maxIdentities?: number;
  maxRetainedBytes?: number;
}
/** Synchronous pure fold. SDK generation/segment/order provenance is independent of message text. */
export class CursorTranslator implements Translator {
  private diagnostics: import("@ace/protocol").RawPayload[] = [];
  private root: Key;
  private rootSeen = false;
  private generation: string | undefined;
  private operation: string | undefined;
  private segment = 0;
  private sequence = -1;
  private active = false;
  private replacement = false;
  private interrupted = false;
  private cwd = "";
  private transcript: Transcript;
  private tools: ToolEvents;
  private children: Children;
  private max: number;
  private retainedLimit: number;
  private usagePosition = 0;
  private overflow = false;
  private current: CursorEnvelope | undefined;
  constructor(options: CursorTranslatorOptions) {
    this.root = options.rootKey;
    this.max = options.maxIdentities ?? 2048;
    this.retainedLimit = options.maxRetainedBytes ?? 2_097_152;
    if (
      !Number.isSafeInteger(this.max) ||
      this.max < 1 ||
      this.max > 8192 ||
      !Number.isSafeInteger(this.retainedLimit) ||
      this.retainedLimit < 4096 ||
      this.retainedLimit > 8_388_608
    )
      throw new Error("Invalid SDK translator budget");
    this.children = new Children(this.max);
    this.tools = new ToolEvents({
      children: this.children,
      limit: this.max,
      retainedLimit: this.retainedLimit,
    });
    this.transcript = new Transcript("unopened", this.max);
  }
  takeDiagnostics(): import("@ace/protocol").RawPayload[] {
    const diagnostics = this.diagnostics;
    this.diagnostics = [];
    return diagnostics;
  }
  tick(_now: number): Fact[] {
    return [];
  }
  translate(frame: Frame, _now: number): Fact[] {
    this.diagnostics = [];
    if (frame.channel !== "sdk" || this.overflow) return [];
    try {
      // Synthetic/replay callers get the same admission guard as live encoded ingress.
      const payload =
        frame.payload && ProviderPayload.is(frame.payload) && frame.payload.data === frame.data
          ? frame.payload
          : new ProviderPayload(boundedJson(frame.data));
      this.diagnostics = [{ type: "cursor.sdk.v1", data: payload.data }];
      const parsed = Envelope.safeParse(payload.data);
      if (!parsed.success)
        return [this.notice("Malformed SDK boundary envelope", frame.data, "error")];
      const event = parsed.data;
      if (this.generation && this.generation !== event.generation) {
        if (event.kind !== "open") return [];
        this.sequence = -1;
        this.generation = event.generation;
      }
      if (frame.seq <= this.sequence) return [];
      this.sequence = frame.seq;
      this.generation ??= event.generation;
      this.current = event;
      const body = object(event.body);
      const namespace = `${event.generation}:${event.operationId}:${event.segment}`;
      if (event.kind === "open") {
        this.rootSeen = true;
        this.cwd = string(body.cwd) ?? "";
        const model = string(body.model);
        return [
          {
            type: "agent.seen",
            agent: this.root,
            origin: "root",
            fidelity: "full",
            cwd: this.cwd,
            ...(model ? { model } : {}),
            native: { provider: "cursor", ...(event.agentId ? { nativeId: event.agentId } : {}) },
          },
        ];
      }
      if (event.kind === "send") {
        const facts: Fact[] = [];
        if (this.operation !== event.operationId || !this.active) {
          this.tools.trim();
          this.children.trim();
          this.usagePosition = 0;
          this.operation = event.operationId;
          this.active = true;
          facts.push({
            type: "turn.started",
            agent: this.root,
            nativeTurnId: `sdk:${event.operationId}`,
            trigger: "user",
          });
        }
        facts.push(...this.transcript.end());
        const input = z.array(ContentPart).max(64).safeParse(body.input);
        if (input.success && input.data.length)
          facts.push({
            type: "item.upsert",
            agent: this.root,
            item: `${namespace}:user:${event.commandId ?? event.segment}`,
            draft: {
              type: "message",
              role: "user",
              parts: input.data,
              complete: true,
              ...(event.commandId && event.commandId.length <= 256
                ? { nativeId: event.commandId }
                : {}),
            },
          });
        this.segment = event.segment;
        this.replacement = false;
        this.interrupted = false;
        this.transcript = new Transcript(namespace, this.max);
        return facts;
      }
      if (event.kind === "observe") return [];
      if (event.kind === "recovery")
        return [
          ...this.children.preserve(),
          this.notice(
            string(body.text) ?? "SDK checkpoint recovery reconciled",
            event,
            body.interrupted ? "warning" : "info",
          ),
        ];
      if (event.kind === "snapshot")
        return [
          this.notice(
            "Checkpoint snapshot retained for reconciliation; positional UUIDs do not establish live-message identity. No uncertain history was appended.",
            event,
            "warning",
          ),
        ];
      // A shared host/store failure fences execution even when an old segment caused it.
      if (
        event.kind === "error" &&
        ["boundary_overflow", "checkpoint_budget"].includes(string(body.code) ?? "")
      )
        return [
          ...this.tools.preserve(),
          ...this.children.preserve(),
          this.notice(
            string(body.message) ?? "SDK host resource budget failed; checkpoint retained",
            event,
            "error",
          ),
          { type: "process.exited", deliberate: false, message: "SDK host resource budget failed" },
        ];
      if (event.kind === "blob") return [{ type: "signal", agent: this.root }];
      if (event.kind === "shell-output") {
        const parent = nativeIdentity(body.parentCallId);
        const child = parent ? this.children.calls.get(`${namespace}:call:${parent}`) : undefined;
        if (parent && !child)
          return [this.notice("Shell output has no observed owning child", event, "warning")];
        return this.tools.output(
          body,
          child?.key ?? this.root,
          namespace,
          event,
          this.transcript,
          this.operation,
          this.segment,
          this.cwd,
          (text, data, level) => this.notice(text, data, level),
        );
      }
      const stale = event.operationId !== this.operation || event.segment !== this.segment;
      if (event.kind === "host-exit")
        return [
          ...this.children.preserve(),
          this.notice(
            "SDK host exited; unresolved child/background work is uncertain",
            event,
            "warning",
          ),
        ];
      if (stale && !(event.kind === "error" && event.operationId === "open" && !this.rootSeen)) {
        // Surviving child facts belong to their original call namespace, never the replacement root.
        if (event.kind === "delta" && body.type === "tool-call-completed") {
          const call = `${namespace}:call:${nativeIdentity(body.callId) ?? ""}`;
          if (this.tools.calls.has(call) || this.children.calls.has(call)) {
            return this.delta(body, this.tools.calls.get(call)?.agent ?? this.root, namespace, 0);
          }
        }
        if (["delta", "delta-chunk"].includes(event.kind) && body.type === "tool-call-delta") {
          const call = `${namespace}:call:${nativeIdentity(body.callId) ?? ""}`;
          const child = this.children.calls.get(call);
          if (child && !child.settled)
            return this.delta(object(body.taskUpdate), child.key, namespace, 1);
        }
        return [];
      }
      switch (event.kind) {
        case "segment":
          return [];
        case "delta-chunk":
        case "delta":
          return this.delta(body, this.root, namespace, 0);
        case "message": {
          // Local 1.0.35 maps onDelta into these same messages. Never append both channels.
          if (
            ["assistant", "thinking", "tool_call", "usage", "user", "system", "status"].includes(
              string(body.type) ?? "",
            )
          )
            return [{ type: "signal", agent: this.root }];
          if (body.type === "task")
            return [this.notice("SDK task summary has no independent child identity", event)];
          return [this.notice("Unknown SDK stream message retained", event)];
        }
        case "cancel": {
          if (frame.dir === "send") {
            this.replacement = body.replacement === true;
            this.interrupted = !this.replacement;
          }
          return [];
        }
        case "result": {
          if (!this.active)
            return [
              this.notice(
                "Repeated SDK terminal result retained; the canonical outcome is unchanged",
                event,
              ),
            ];
          if (!["finished", "cancelled", "error"].includes(string(body.status) ?? ""))
            return [
              ...this.tools.preserve(),
              ...this.children.preserve(),
              this.notice(
                "Unrecognized SDK terminal status; execution remains uncertain",
                event,
                "warning",
              ),
            ];
          const facts = [
            ...this.transcript.end(),
            ...this.tools.preserve(),
            ...this.children.preserve(),
          ];
          if (body.status === "error")
            facts.push(
              this.notice(
                string(object(body.error).message) ?? "Cursor SDK run failed",
                event,
                "error",
              ),
            );
          if (this.replacement) return facts;
          this.active = false;
          const outcome =
            body.status === "finished"
              ? "completed"
              : body.status === "cancelled" || this.interrupted
                ? "interrupted"
                : "failed";
          facts.push({
            type: "turn.ended",
            agent: this.root,
            nativeTurnId: `sdk:${event.operationId}`,
            outcome,
            ...(outcome === "failed"
              ? {
                  error: {
                    kind: failureKind(object(body.error).code),
                    message: string(object(body.error).message) ?? "Cursor SDK run failed",
                  },
                }
              : {}),
          });
          return facts;
        }
        case "error": {
          const facts: Fact[] = [];
          if (!this.rootSeen) {
            this.rootSeen = true;
            facts.push({
              type: "agent.seen",
              agent: this.root,
              origin: "root",
              fidelity: "full",
              native: { provider: "cursor" },
              cwd: this.cwd,
            });
          }
          facts.push(
            ...this.tools.preserve(),
            ...this.children.preserve(),
            this.notice(
              string(body.message) ?? "SDK failure; delivery or execution is uncertain",
              event,
              "error",
            ),
          );
          if (this.active && !this.replacement) {
            this.active = false;
            facts.push({
              type: "turn.ended",
              agent: this.root,
              nativeTurnId: `sdk:${event.operationId}`,
              outcome: "failed",
              error: {
                kind: failureKind(body.code),
                message: string(body.message) ?? "SDK run failed",
              },
            });
          }
          return facts;
        }
        case "close":
          return this.children.preserve();
        default:
          return [this.notice("Unknown SDK envelope retained", event)];
      }
    } catch {
      if (this.overflow) return [];
      this.overflow = true;
      return [
        ...this.children.preserve(),
        this.notice(
          "SDK payload or identity budget exceeded. Host must be stopped; checkpoint retained and surviving work remains uncertain.",
          { overflow: true },
          "error",
        ),
        { type: "process.exited", deliberate: false, message: "SDK translation budget exceeded" },
      ];
    }
  }
  private notice(text: string, data: unknown, level: "info" | "warning" | "error" = "info"): Fact {
    return {
      type: "item.upsert",
      agent: this.root,
      item: `sdk:notice:${this.generation ?? "invalid"}:${this.sequence}`,
      draft: {
        type: "notice",
        text,
        level,
        complete: true,
        raw: [this.current?.raw ?? { type: "cursor.sdk.v1", data }],
      },
    };
  }
  private delta(
    body: Record<string, unknown>,
    agent: Key,
    namespace: string,
    depth: number,
  ): Fact[] {
    return translateDelta(
      body,
      agent,
      namespace,
      {
        children: this.children,
        tools: this.tools,
        transcript: this.transcript,
        current: this.current,
        operation: this.operation,
        segment: this.segment,
        cwd: this.cwd,
        nextUsage: () => ++this.usagePosition,
        notice: (text, data, level) => this.notice(text, data, level),
      },
      depth,
    );
  }
}

function failureKind(code: unknown): "auth" | "quota" | "network" | "provider" {
  if (code === "auth") return "auth";
  if (code === "rate_limit") return "quota";
  if (code === "network") return "network";
  return "provider";
}
