import type { Fact, Key } from "@ace/core";
import type { Frame, Translator } from "@ace/engine-api";
import { ContentPart, type ThreadId } from "@ace/protocol";
import { z } from "zod";
import { boundedJson } from "@ace/provider-kit/ipc";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { Envelope, object, string, nativeIdentity, type CursorEnvelope } from "./contracts.ts";
import { Children } from "./children.ts";
import { Transcript } from "./transcript.ts";
import { toolKind, toolDetail, toolStatus } from "./tools.ts";
import { turnUsage } from "./usage.ts";

interface Tool {
  agent: Key;
  name: string;
  args: unknown;
  argsBytes: number;
  terminal: boolean;
  failed: boolean;
  output: boolean;
}
export interface CursorTranslatorOptions {
  threadId: ThreadId;
  rootKey: Key;
  maxIdentities?: number;
  maxRetainedBytes?: number;
}
/** Synchronous pure fold. SDK generation/segment/order provenance is independent of message text. */
export class CursorTranslator implements Translator {
  private root: Key;
  private generation: string | undefined;
  private operation: string | undefined;
  private segment = 0;
  private sequence = -1;
  private active = false;
  private replacement = false;
  private interrupted = false;
  private cwd = "";
  private transcript: Transcript;
  private tools = new Map<Key, Tool>();
  private children: Children;
  private max: number;
  private retainedBytes = 0;
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
    this.transcript = new Transcript("unopened", this.max);
  }
  tick(_now: number): Fact[] {
    return [];
  }
  translate(frame: Frame, _now: number): Fact[] {
    if (frame.channel !== "sdk" || this.overflow) return [];
    try {
      // Synthetic/replay callers get the same admission guard as live encoded ingress.
      const payload =
        frame.payload && ProviderPayload.is(frame.payload) && frame.payload.data === frame.data
          ? frame.payload
          : new ProviderPayload(boundedJson(frame.data));
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
          this.notice(
            "Cursor SDK local runtime; task children are read-only and nested transcripts are incomplete",
            event,
          ),
        ];
      }
      if (event.kind === "send") {
        const facts: Fact[] = [];
        if (this.operation !== event.operationId || !this.active) {
          for (const [key, tool] of this.tools)
            if (tool.terminal) {
              this.tools.delete(key);
              this.retainedBytes -= tool.argsBytes;
            }
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
            draft: { type: "message", role: "user", parts: input.data, complete: true },
          });
        this.segment = event.segment;
        this.replacement = false;
        this.interrupted = false;
        this.transcript = new Transcript(namespace, this.max);
        facts.push(
          this.notice(
            `SDK logical operation ${event.operationId}, segment ${event.segment}`,
            event,
          ),
        );
        return facts;
      }
      if (event.kind === "observe")
        return [
          this.notice("SDK durable event retained; callback journal owns canonical content", event),
        ];
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
          ...this.preserveTools(),
          ...this.children.preserve(),
          this.notice(
            string(body.message) ?? "SDK host resource budget failed; checkpoint retained",
            event,
            "error",
          ),
          { type: "process.exited", deliberate: false, message: "SDK host resource budget failed" },
        ];
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
      if (stale) {
        // Surviving child facts belong to their original call namespace, never the replacement root.
        if (event.kind === "delta" && body.type === "tool-call-completed") {
          const call = `${namespace}:call:${nativeIdentity(body.callId) ?? ""}`;
          if (this.tools.has(call) || this.children.calls.has(call)) {
            return this.delta(body, this.tools.get(call)?.agent ?? this.root, namespace, 0);
          }
        }
        if (event.kind === "delta" && body.type === "tool-call-delta") {
          const call = `${namespace}:call:${nativeIdentity(body.callId) ?? ""}`;
          const child = this.children.calls.get(call);
          if (child && !child.settled)
            return this.delta(object(body.taskUpdate), child.key, namespace, 1);
        }
        return [];
      }
      switch (event.kind) {
        case "segment":
          return [
            this.notice(
              `SDK run ${event.runId ?? string(body.nativeRunId) ?? "unknown"} belongs to segment ${event.segment}`,
              event,
            ),
          ];
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
          return [
            this.notice(
              this.replacement
                ? "SDK cancellation requested before replacement segment"
                : "SDK cancellation boundary",
              event,
            ),
          ];
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
              ...this.preserveTools(),
              ...this.children.preserve(),
              this.notice(
                "Unrecognized SDK terminal status; execution remains uncertain",
                event,
                "warning",
              ),
            ];
          const facts = [
            ...this.transcript.end(),
            ...this.preserveTools(),
            ...this.children.preserve(),
            this.notice(
              "SDK segment terminal result; cumulative usage is retained without adding it to turn usage",
              event,
            ),
          ];
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
          const facts: Fact[] = [
            ...this.preserveTools(),
            ...this.children.preserve(),
            this.notice(
              string(body.message) ?? "SDK failure; delivery or execution is uncertain",
              event,
              "error",
            ),
          ];
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
          return [...this.children.preserve(), this.notice("SDK host disposal boundary", event)];
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
        raw: [{ type: "cursor.sdk.v1", data }],
      },
    };
  }
  private delta(
    body: Record<string, unknown>,
    agent: Key,
    namespace: string,
    depth: number,
  ): Fact[] {
    const type = string(body.type);
    if (type === "text-delta" || type === "thinking-delta")
      return this.transcript.append(
        agent,
        type === "text-delta" ? "text" : "thinking",
        string(body.text) ?? "",
      );
    if (type === "step-started" || type === "step-completed" || type === "thinking-completed")
      return this.transcript.boundary(agent);
    if (type === "turn-ended")
      return turnUsage(body.usage, agent, `${namespace}:${agent}:usage:${++this.usagePosition}`);
    if (type === "tool-call-delta") {
      if (depth >= 1)
        return [
          this.notice(
            "Nested task deltas beyond one level are incomplete",
            this.current,
            "warning",
          ),
        ];
      const call = `${namespace}:call:${nativeIdentity(body.callId) ?? ""}`;
      const child = this.children.calls.get(call);
      if (!child)
        return [
          this.notice("Nested update has no observed owning task call", this.current, "warning"),
        ];
      return this.delta(object(body.taskUpdate), child.key, namespace, depth + 1);
    }
    if (
      type === "tool-call-started" ||
      type === "partial-tool-call" ||
      type === "tool-call-completed"
    ) {
      const callId = nativeIdentity(body.callId);
      if (!callId)
        return [this.notice("SDK tool update lacks native call identity", this.current, "warning")];
      const call = `${namespace}:call:${callId}`;
      const native = object(body.toolCall);
      const name =
        nativeIdentity(native.name) ??
        nativeIdentity(native.type) ??
        this.tools.get(call)?.name ??
        "unknown";
      let tool = this.tools.get(call);
      if (!tool) {
        if (this.tools.size + this.children.calls.size >= this.max)
          throw new Error("SDK identity cap");
        tool = {
          agent,
          name,
          args: undefined,
          argsBytes: 0,
          terminal: false,
          failed: false,
          output: false,
        };
        this.tools.set(call, tool);
      }
      if (native.args !== undefined) {
        const argsBytes = Buffer.byteLength(boundedJson(native.args, 262144));
        if (this.retainedBytes - tool.argsBytes + argsBytes > this.retainedLimit)
          throw new Error("SDK retained tool argument budget exceeded");
        this.retainedBytes += argsBytes - tool.argsBytes;
        tool.argsBytes = argsBytes;
        tool.args = native.args;
      }
      const status = toolStatus(
        type === "tool-call-completed" ? "completed" : "running",
        native.result,
      );
      tool.failed ||= status === "failed";
      if (tool.terminal && type !== "tool-call-completed") return [];
      tool.terminal ||= status !== "running";
      const staleCompletion =
        this.current?.operationId !== this.operation || this.current?.segment !== this.segment;
      const facts = staleCompletion ? [] : this.transcript.boundary(agent);
      if (toolKind(name) === "agent.spawn") {
        facts.push(...this.children.ensure(call, agent, tool.args, this.cwd));
        if (tool.terminal)
          facts.push(...this.children.result(call, native.result, tool.failed, this.cwd));
      }
      facts.push({
        type: "item.upsert",
        agent,
        item: call,
        draft: {
          type: "tool_call",
          complete: tool.terminal,
          call: {
            kind: toolKind(name),
            title: name,
            status: tool.failed ? "failed" : status,
            detail: toolDetail(name, tool.args, native.result),
            raw: [{ type: "cursor.sdk.tool", name, data: this.current }],
            ...(tool.failed
              ? { error: "Cursor tool failed or was denied by execution policy" }
              : {}),
          },
        },
      });
      const truncation = object(native.truncated);
      if (truncation.args === true || truncation.result === true)
        facts.push(
          this.notice(
            "Cursor SDK tool args/result were truncated by the SDK",
            this.current,
            "warning",
          ),
        );
      const result = object(object(native.result).value);
      if (toolKind(name) === "shell" && tool.terminal && !tool.output) {
        const output = (string(result.stdout) ?? "") + (string(result.stderr) ?? "");
        if (output)
          facts.push({ type: "item.delta", agent, item: call, field: "output", append: output });
        tool.output = true;
      }
      return facts;
    }
    // Shell output events are opaque records; keep them rather than inventing call association.
    if (type === "shell-output-delta")
      return [
        this.notice("SDK shell output delta retained; call association unavailable", this.current),
      ];
    return [this.notice("Unknown SDK delta retained", this.current)];
  }
  private preserveTools(): Fact[] {
    const facts: Fact[] = [];
    for (const [item, tool] of this.tools)
      if (!tool.terminal && toolKind(tool.name) !== "agent.spawn") {
        facts.push({
          type: "background.started",
          agent: tool.agent,
          task: `surviving:${item}`,
          kind: toolKind(tool.name) === "shell" ? "shell" : "other",
          title: `Unresolved SDK ${tool.name}`,
          item,
          stoppable: false,
        });
        facts.push({
          type: "background.ended",
          task: `surviving:${item}`,
          status: "unknown",
          uncertain: true,
        });
      }
    return facts;
  }
}

function failureKind(code: unknown): "auth" | "quota" | "network" | "provider" {
  if (code === "auth") return "auth";
  if (code === "rate_limit") return "quota";
  if (code === "network") return "network";
  return "provider";
}
