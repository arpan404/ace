import { z } from "zod";
import {
  AgentId,
  Interaction,
  InteractionId,
  ThreadId,
  type Command,
  type CommandResult,
  type ScreenState,
  type ScreenAgentScope,
} from "@ace/protocol";
import type { Store } from "./store.ts";
import type { Engine } from "./engine/index.ts";
import { ScreenGrants, sensitiveApp } from "./screen-grants.ts";

class ScreenApprovalError extends Error {
  readonly code: "screen_disabled" | "denied" | "timeout" | "read_only";
  constructor(code: ScreenApprovalError["code"], message: string) {
    super(message);
    this.code = code;
  }
}
const Pending = z.object({
  interaction_id: InteractionId,
  thread_id: ThreadId,
  key: z.string(),
  bundle_id: z.string(),
  kind: z.enum(["app", "foreground", "device"]),
  turn_id: z.string(),
});
/** Blocking engine interactions. Human choices remain separate from provider approval options. */
export class ScreenApprovals {
  private readonly waiters = new Map<string, () => void>();
  private readonly unwatch: () => void;
  private closing = false;
  private readonly options: {
    store: Store;
    grants: ScreenGrants;
    now(): number;
    id(): string;
    engine(): Engine | undefined;
    schedule(callback: () => void, milliseconds: number): () => void;
  };
  constructor(options: {
    store: Store;
    grants: ScreenGrants;
    now(): number;
    id(): string;
    engine(): Engine | undefined;
    schedule(callback: () => void, milliseconds: number): () => void;
  }) {
    this.options = options;
    options.store.atomic((db) =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS screen_pending (interaction_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, key TEXT NOT NULL, bundle_id TEXT NOT NULL, kind TEXT NOT NULL, turn_id TEXT NOT NULL)",
      ),
    );
    this.unwatch = options.store.subscribe((events) => {
      for (const event of events)
        if (event.payload.type === "interaction.closed")
          this.waiters.get(event.payload.interactionId)?.();
    });
  }
  recover() {
    for (const raw of this.options.store.atomic((db) =>
      db.prepare("SELECT * FROM screen_pending").all(),
    ))
      this.expire(Pending.parse(raw));
  }
  async request(bundleId: string, reason: string, caller: ScreenAgentScope, signal: AbortSignal) {
    if (!this.options.grants.enabled())
      throw new ScreenApprovalError("screen_disabled", "Screen access is disabled");
    if (!sensitiveApp(bundleId) && this.options.grants.allows(bundleId, caller)) return;
    await this.ask("app", bundleId, reason, caller, signal);
  }
  async device(deviceId: string, name: string, caller: ScreenAgentScope, signal: AbortSignal) {
    await this.ask(
      "device",
      deviceId,
      `Allow this agent to use ${name} for this thread. This enables devices; iOS also enables computer use and shares Simulator with this thread. Revoke removes the grant.`,
      caller,
      signal,
      name,
    );
  }
  async foreground(
    state: ScreenState,
    signal: AbortSignal,
    reason = "This app requires foreground input",
  ) {
    if (!state.holder || state.target.kind === "display")
      throw new Error("Foreground approval requires an agent-controlled app session");
    await this.ask(
      "foreground",
      state.target.bundleId,
      `Allow session ${state.sessionId} to activate the app and use the real cursor and keyboard focus. ${reason}`,
      state.holder,
      signal,
    );
  }
  private async ask(
    kind: "app" | "foreground" | "device",
    bundleId: string,
    reason: string,
    caller: ScreenAgentScope,
    signal: AbortSignal,
    deviceName?: string,
  ) {
    signal.throwIfAborted();
    if (this.closing || this.waiters.size >= 32) throw new Error("Screen approval unavailable");
    const { store, engine, now, id } = this.options;
    const threadId = ThreadId.parse(caller.threadId),
      key = `screen-approval:${id()}`;
    const thread = store.getThread(threadId);
    if (!thread || thread.deletedAt !== undefined)
      throw new Error("Screen approval thread unavailable");
    if ((engine()?.permissionAuthority(threadId) ?? thread.permission?.effective) === "read-only")
      throw new ScreenApprovalError("read_only", "Read-only mode refuses computer use");
    const request: Interaction["request"] = {
      kind: "approval",
      title:
        kind === "device"
          ? `Use ${deviceName}`
          : kind === "app"
            ? `Use ${bundleId}`
            : `Foreground computer use: ${bundleId}`,
      description: reason,
      target: {
        tool:
          kind === "device"
            ? "device_request"
            : kind === "app"
              ? "screen_request_app"
              : "screen_request_foreground",
        access: "execute",
        origin: "ace",
        riskClass: "external-effect",
        input: kind === "device" ? { device: deviceName } : { bundleId, kind },
      },
      options: [
        ...(kind === "device"
          ? [{ id: "allow_thread", kind: "allow_session" as const, label: "Allow for this thread" }]
          : [{ id: "allow_once", kind: "allow_once" as const, label: "Allow once" }]),
        ...(kind === "app"
          ? [
              {
                id: "allow_thread",
                kind: "allow_session" as const,
                label: "Allow for this thread",
              },
              { id: "allow_always", kind: "allow_always" as const, label: "Always" },
            ]
          : []),
        { id: "deny", kind: "deny", label: "Deny" },
      ],
      defaultToNo: true,
    };
    const raw = [{ type: "ace.screen.approval", data: { key, bundleId, kind } }];
    const host = engine();
    const interactionId = host
      ? host.openHostApproval(threadId, key, request, raw)
      : InteractionId.parse(id());
    if (!host)
      store.appendEvents(
        threadId,
        [
          {
            type: "interaction.opened",
            interaction: Interaction.parse({
              id: interactionId,
              threadId,
              agentId: AgentId.parse(caller.agentId),
              blocking: true,
              state: "pending",
              createdAt: now(),
              request,
              raw,
            }),
          },
        ],
        now(),
      );
    const pending = Pending.parse({
      interaction_id: interactionId,
      thread_id: threadId,
      key,
      bundle_id: bundleId,
      kind,
      turn_id: this.options.grants.currentTurn(threadId) ?? "",
    });
    store.atomic((db) =>
      db
        .prepare("INSERT INTO screen_pending VALUES (?,?,?,?,?,?)")
        .run(interactionId, threadId, key, bundleId, kind, pending.turn_id),
    );
    await new Promise<void>((resolve) => {
      const finish = () => {
        cancelTimer();
        signal.removeEventListener("abort", abort);
        this.waiters.delete(interactionId);
        resolve();
      };
      const abort = () => {
        this.expire(pending);
        finish();
      };
      const cancelTimer = this.options.schedule(abort, 60_000);
      this.waiters.set(interactionId, finish);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else if (store.getInteraction(interactionId)?.state !== "pending") finish();
    });
    signal.throwIfAborted();
    const result = store.getInteraction(interactionId);
    if (
      result?.state !== "resolved" ||
      result.resolution?.kind !== "approval" ||
      result.resolution.optionId === "deny"
    )
      throw new ScreenApprovalError(
        result?.state === "expired" ? "timeout" : "denied",
        "Screen approval denied or expired",
      );
    if (
      (engine()?.permissionAuthority(threadId) ??
        store.getThread(threadId)?.permission?.effective) === "read-only"
    )
      throw new ScreenApprovalError("read_only", "Read-only mode refuses computer use");
    if (kind === "app" && !this.options.grants.allows(bundleId, caller))
      throw new Error("Screen approval revoked");
  }
  resolve(command: Command): CommandResult | undefined {
    if (command.payload.type !== "interaction.resolve") return;
    const payload = command.payload,
      { store, grants } = this.options;
    const raw = store.atomic((db) =>
      db.prepare("SELECT * FROM screen_pending WHERE interaction_id=?").get(payload.interactionId),
    );
    if (!raw) return;
    const pending = Pending.parse(raw),
      interaction = store.getInteraction(payload.interactionId);
    const fail = (error: string) => ({ commandId: command.id, ok: false, error });
    if (["ace-reviewer", "ace-agent"].includes(command.deviceId))
      return fail("human_approval_required");
    if (interaction?.state !== "pending") return fail("already_resolved");
    if (
      payload.resolution.kind !== "approval" ||
      !interaction.request ||
      interaction.request.kind !== "approval" ||
      !interaction.request.options.some(
        (option) =>
          option.id === (payload.resolution.kind === "approval" ? payload.resolution.optionId : ""),
      )
    )
      return fail("invalid_resolution");
    if (pending.turn_id && pending.turn_id !== grants.currentTurn(pending.thread_id)) {
      this.expire(pending);
      return fail("turn_changed");
    }
    const choice = payload.resolution.optionId;
    store.atomic((db) => {
      if (pending.kind === "app" && choice === "deny" && sensitiveApp(pending.bundle_id))
        grants.approve(pending.bundle_id, false, "turn", pending.thread_id);
      if (pending.kind === "app" && choice !== "deny") {
        grants.approve(
          pending.bundle_id,
          true,
          choice === "allow_always" ? "always" : choice === "allow_thread" ? "thread" : "turn",
          pending.thread_id,
        );
        if (sensitiveApp(pending.bundle_id) && choice !== "allow_once")
          grants.approve(pending.bundle_id, true, "turn", pending.thread_id);
      }
      this.closed(pending, {
        state: "resolved",
        resolvedBy: command.deviceId,
        resolution: payload.resolution,
      });
      db.prepare("DELETE FROM screen_pending WHERE interaction_id=?").run(pending.interaction_id);
    });
    return { commandId: command.id, ok: true, threadId: pending.thread_id };
  }
  private closed(
    pending: z.infer<typeof Pending>,
    result: {
      state: "resolved" | "expired";
      resolvedBy?: import("@ace/protocol").DeviceId;
      resolution?: import("@ace/protocol").InteractionResolution;
    },
  ) {
    const engine = this.options.engine();
    if (engine) engine.resolveHostApproval(pending.thread_id, pending.key, result);
    else
      this.options.store.appendEvents(
        pending.thread_id,
        [
          {
            type: "interaction.closed",
            interactionId: pending.interaction_id,
            closedAt: this.options.now(),
            ...result,
          },
        ],
        this.options.now(),
      );
  }
  private expire(pending: z.infer<typeof Pending>) {
    if (this.options.store.getInteraction(pending.interaction_id)?.state === "pending")
      this.closed(pending, { state: "expired" });
    this.options.store.atomic((db) =>
      db.prepare("DELETE FROM screen_pending WHERE interaction_id=?").run(pending.interaction_id),
    );
  }
  close() {
    this.closing = true;
    this.recover();
    for (const finish of this.waiters.values()) finish();
    this.unwatch();
  }
}
