import { z } from "zod";
import { InteractionResolution, type InteractionRequest } from "@ace/protocol";
import type {
  PermissionResult,
  PermissionUpdate,
  ElicitationResult,
} from "@anthropic-ai/claude-agent-sdk";
import { requestFor } from "./interactions.ts";
import { permissionResult } from "./input.ts";

type Emit = (dir: "send" | "recv", channel: string, data: unknown) => void;
type Pending = {
  request: InteractionRequest;
  answer(resolution: InteractionResolution): void;
  cancel(): void;
  expire(): void;
};
const ElicitationAnswer = z.object({
  action: z.enum(["accept", "decline", "cancel"]),
  content: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
    .optional(),
});
/** Human waits have no deadline. Capacity rejects excess work instead of evicting a live ask. */
export class PendingInteractions {
  private readonly requests = new Map<string, Pending>();
  private readonly cancelled = new Set<string>();
  private readonly emit: Emit;
  private ended = false;
  constructor(emit: Emit) {
    this.emit = emit;
  }
  cancel(id: string): void {
    const request = this.requests.get(id);
    if (request) request.cancel();
    else {
      if (this.cancelled.size >= 256)
        this.cancelled.delete(this.cancelled.values().next().value ?? "");
      this.cancelled.add(id);
    }
  }
  expire(): void {
    this.ended = true;
    for (const request of this.requests.values()) request.expire();
    this.cancelled.clear();
  }
  resolve(id: string, value: InteractionResolution): void {
    const pending = this.requests.get(id);
    if (!pending) throw new Error("Claude interaction is no longer pending");
    const resolution = InteractionResolution.parse(value);
    if (resolution.kind !== pending.request.kind)
      throw new Error("Claude interaction resolution kind does not match");
    if (
      resolution.kind === "approval" &&
      pending.request.kind === "approval" &&
      !pending.request.options.some((option) => option.id === resolution.optionId)
    )
      throw new Error("Unknown Claude approval option");
    pending.answer(resolution);
  }
  permission(
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      requestId: string;
      suggestions?: PermissionUpdate[];
    },
  ): Promise<PermissionResult> {
    const { signal, ...meta } = options;
    const request = requestFor(toolName, input, meta);
    return this.wait(
      options.requestId,
      signal,
      request,
      "can_use_tool",
      { toolName, input, options: meta },
      (answer) => permissionResult(answer, input, options.suggestions ?? []),
      { behavior: "deny", message: "Claude request ended." },
    );
  }
  elicitation(
    data: {
      serverName: string;
      message: string;
      mode?: "form" | "url";
      url?: string;
      elicitationId?: string;
      requestedSchema?: Record<string, unknown>;
      title?: string;
      description?: string;
    },
    options: { signal: AbortSignal; requestId: string },
  ): Promise<ElicitationResult> {
    const request: InteractionRequest = {
      kind: "elicitation",
      server: data.serverName,
      message: data.message,
      ...(data.mode ? { mode: data.mode } : {}),
      ...(data.url ? { url: data.url } : {}),
      ...(data.elicitationId ? { nativeId: data.elicitationId } : {}),
      ...(data.requestedSchema ? { schema: data.requestedSchema } : {}),
      ...(data.title ? { title: data.title } : {}),
      ...(data.description ? { description: data.description } : {}),
    };
    return this.wait(
      options.requestId,
      options.signal,
      request,
      "elicitation",
      { requestId: options.requestId, request, native: data },
      (answer) => {
        if (answer.kind !== "elicitation") throw new Error("Expected elicitation answer");
        return ElicitationAnswer.parse({
          action: answer.action,
          ...(answer.content === undefined ? {} : { content: answer.content }),
        });
      },
      { action: "cancel" },
    );
  }
  private wait<T>(
    id: string,
    signal: AbortSignal,
    request: InteractionRequest,
    channel: string,
    data: unknown,
    answer: (resolution: InteractionResolution) => T,
    cancelled: T,
  ): Promise<T> {
    if (this.requests.size >= 256)
      return Promise.reject(new Error("Claude interaction capacity reached"));
    if (this.requests.has(id)) return Promise.reject(new Error("Duplicate Claude request id"));
    return new Promise<T>((resolve) => {
      const finish = (
        value: T,
        state: "resolved" | "cancelled" | "expired",
        resolution?: InteractionResolution,
      ) => {
        if (!this.requests.delete(id)) return;
        signal.removeEventListener("abort", abort);
        this.emit(
          state === "resolved" ? "send" : "recv",
          state === "resolved" ? channel : "interaction_lifecycle",
          state === "resolved"
            ? { requestId: id, result: value, resolution }
            : { requestId: id, state },
        );
        resolve(value);
      };
      const abort = () => finish(cancelled, "cancelled");
      this.requests.set(id, {
        request,
        answer: (resolution) => finish(answer(resolution), "resolved", resolution),
        cancel: abort,
        expire: () => finish(cancelled, "expired"),
      });
      this.emit("recv", channel, data);
      if (this.ended) finish(cancelled, "expired");
      else if (signal.aborted || this.cancelled.delete(id)) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }
}
