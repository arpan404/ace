import { type ScreenAgentScope, type ScreenState, type InteractionResolution } from "@ace/protocol";
import { sensitiveApp } from "@ace/screen/sensitive-app";
import type { FakeServiceContext } from "./service-context.ts";
import { FakeScreenAccess, FakeScreenError } from "./screen-access.ts";

export interface FakeScreenApprovalOptions {
  host: FakeServiceContext;
  access: FakeScreenAccess;
  id(): string;
  schedule(callback: () => void, delay: number): () => void;
}
/** Host approval facts and resolution choices match the daemon's screen-approvals.ts. */
export class FakeScreenApprovals {
  private readonly options: FakeScreenApprovalOptions;
  private readonly pending = new Map<
    string,
    { turn: string | undefined; kind: "app" | "foreground"; finish(option?: string): void }
  >();
  constructor(options: FakeScreenApprovalOptions) {
    this.options = options;
    options.host.onResolved?.((threadId, key, resolution) => {
      this.pending
        .get(`${threadId}:${key}`)
        ?.finish(resolution?.kind === "approval" ? resolution.optionId : undefined);
    });
  }
  resolutionError(
    threadId: string,
    key: string,
    deviceId: string,
    resolution: InteractionResolution,
  ): string | undefined {
    const pending = this.pending.get(`${threadId}:${key}`);
    if (!pending) return "already_resolved";
    if (["ace-agent", "ace-reviewer"].includes(deviceId)) return "human_approval_required";
    const options =
      pending.kind === "app"
        ? ["allow_once", "allow_thread", "allow_always", "deny"]
        : ["allow_once", "deny"];
    if (resolution.kind !== "approval" || !options.includes(resolution.optionId))
      return "invalid_resolution";
    if (pending.turn && pending.turn !== this.options.access.turn(threadId)) return "turn_changed";
    return;
  }
  async requestApp(
    bundleId: string,
    reason: string,
    caller: ScreenAgentScope,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.options.access.enabled)
      throw new FakeScreenError("screen_disabled", "Screen access is disabled");
    if (!sensitiveApp(bundleId) && this.options.access.allows(bundleId, caller)) return;
    await this.ask("app", bundleId, reason, caller, signal);
  }
  async foreground(
    state: ScreenState,
    reason = "This app requires foreground input",
    signal?: AbortSignal,
  ): Promise<void> {
    if (!state.holder || state.target.kind === "display")
      throw new FakeScreenError(
        "denied",
        "Foreground approval requires an agent-controlled app session",
      );
    await this.ask(
      "foreground",
      state.target.bundleId,
      `Allow session ${state.sessionId} to activate the app and use the real cursor and keyboard focus. ${reason}`,
      state.holder,
      signal,
    );
  }
  private async ask(
    kind: "app" | "foreground",
    bundleId: string,
    reason: string,
    caller: ScreenAgentScope,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const { host, access } = this.options;
    const view = host.thread(caller.threadId);
    if (!view || !host.apply || !host.onResolved)
      throw new FakeScreenError("approval_required", "Screen approval thread unavailable");
    if (view.thread.permission?.effective === "read-only")
      throw new FakeScreenError("read_only", "Read-only mode refuses computer use");
    if (this.pending.size >= 32) throw new FakeScreenError("busy", "Screen approval limit");
    const key = `screen-approval:${this.options.id()}`;
    const pendingKey = `${caller.threadId}:${key}`;
    const option = await new Promise<string | undefined>((resolve, reject) => {
      const finish = (choice?: string) => {
        cancel();
        signal?.removeEventListener("abort", abort);
        this.pending.delete(pendingKey);
        resolve(choice);
      };
      const abort = () => {
        host.apply?.(caller.threadId, [
          { type: "interaction.closed", interaction: key, state: "expired" },
        ]);
        finish();
      };
      const cancel = this.options.schedule(abort, 60_000);
      this.pending.set(pendingKey, { turn: access.turn(caller.threadId), kind, finish });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        host.apply?.(caller.threadId, [
          {
            type: "interaction.opened",
            agent: "root",
            interaction: key,
            blocking: true,
            request: {
              kind: "approval",
              title: kind === "app" ? `Use ${bundleId}` : `Foreground computer use: ${bundleId}`,
              description: reason,
              target: {
                tool: kind === "app" ? "screen_request_app" : "screen_request_foreground",
                access: "execute",
                origin: "ace",
                riskClass: "external-effect",
                input: { bundleId, kind },
              },
              options: [
                { id: "allow_once", kind: "allow_once", label: "Allow once" },
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
            },
            raw: [{ type: "ace.screen.approval", data: { key, bundleId, kind } }],
          },
        ]);
      } catch (error) {
        cancel();
        signal?.removeEventListener("abort", abort);
        this.pending.delete(pendingKey);
        reject(error);
      }
    });
    signal?.throwIfAborted();
    if (kind === "app" && option === "deny" && sensitiveApp(bundleId))
      access.approve(bundleId, false, "turn", caller.threadId);
    if (!option || option === "deny")
      throw new FakeScreenError(option ? "denied" : "timeout", "Screen approval denied or expired");
    if (!access.enabled) throw new FakeScreenError("screen_disabled", "Screen access is disabled");
    if (host.thread(caller.threadId)?.thread.permission?.effective === "read-only")
      throw new FakeScreenError("read_only", "Read-only mode refuses computer use");
    if (kind === "app") {
      access.approve(
        bundleId,
        true,
        option === "allow_always" ? "always" : option === "allow_thread" ? "thread" : "turn",
        caller.threadId,
      );
      if (sensitiveApp(bundleId) && option !== "allow_once")
        access.approve(bundleId, true, "turn", caller.threadId);
    }
  }
}
