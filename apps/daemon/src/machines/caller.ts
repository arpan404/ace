import {
  MachineDelegateResult,
  MachineMessageResult,
  MachineSessionResult,
  MachineStatusResult,
  MachineToolResult,
  type AgentControlResult,
  type DelegationRequest,
  type InteractionResolution,
  type MachineCallOrigin,
  type MachineMessage,
  type MachinePendingRequest,
  type MachineThreadView,
  type McpAttribution,
  type ThreadId,
} from "@ace/protocol";
import { HostId } from "@ace/protocol";
import type { Store } from "../store.ts";
import { AgentControlError } from "../agent-control/failure.ts";
import { clip } from "../agent-control/watch-view.ts";
import type { MachineDirectory } from "./directory.ts";
import type { MachineChildren } from "./children.ts";
import type { RequestMirror } from "./mirror.ts";
import { MachineFailure } from "./transport.ts";

export interface CallerDeps {
  store: Store;
  hostId: string;
  hostName(): Promise<string>;
  directory: MachineDirectory;
  children: MachineChildren;
  mirror: RequestMirror;
  schedule(ms: number, run: () => void): () => void;
  pollMs: number;
}

/**
 * What agents on this machine do on other machines. The target applies its own pairing scope;
 * permissions stay with the calling provider (ace's tools are always allowed).
 */
export class MachineCaller {
  private deps: CallerDeps;
  constructor(deps: CallerDeps) {
    this.deps = deps;
  }
  async origin(threadId: ThreadId): Promise<MachineCallOrigin> {
    return {
      hostId: HostId.parse(this.deps.hostId),
      hostName: clip((await this.deps.hostName()) || "ace", 256) || "ace",
      threadId,
      threadTitle: clip(this.deps.store.getThread(threadId)?.title ?? "", 256),
    };
  }
  async list(caller: McpAttribution): Promise<AgentControlResult> {
    const machines = await this.deps.directory.list(await this.origin(caller.threadId));
    return { ok: true, data: { machines } };
  }
  /** One child on another machine; a retried requestId returns the same child. */
  async delegate(
    caller: McpAttribution,
    request: DelegationRequest,
    signal: AbortSignal,
  ): Promise<ThreadId> {
    const machine = request.machine;
    if (!machine) throw new Error("Machine required");
    if (request.workspace)
      throw new AgentControlError(
        "invalid_arguments",
        "workspace_with_machine",
        undefined,
        "Name a project on that machine with project; workspace selects this machine's checkout.",
      );
    const requestKey = `${caller.threadId}:${request.requestId}`;
    const existing = this.deps.children.byRequest(requestKey);
    if (existing) return existing;
    const origin = await this.origin(caller.threadId);
    const call = {
      op: "delegate" as const,
      requestId: request.requestId,
      ...(request.project ? { project: request.project } : {}),
      task: request.task,
      role: request.role,
      provider: request.provider,
      ...(request.model ? { model: request.model } : {}),
    };
    let answer: { threadId: ThreadId; title: string } | undefined;
    // The target keys creation by requestId, so one retry after a dropped connection is safe.
    for (let attempt = 0; !answer; attempt++) {
      try {
        answer = MachineDelegateResult.parse(
          await this.deps.directory.call(machine, origin, call, { timeoutMs: 30_000, signal }),
        );
      } catch (error) {
        signal.throwIfAborted();
        if (attempt === 0 && error instanceof MachineFailure && error.kind === "disconnected")
          continue;
        throw this.deps.directory.controlError(machine, error);
      }
    }
    this.deps.children.add({
      id: answer.threadId,
      requestKey,
      parentThreadId: caller.threadId,
      parentAgentId: caller.agentId,
      machine,
      role: request.role,
      provider: request.provider,
      model: request.model,
      title: answer.title,
    });
    return answer.threadId;
  }
  async cancel(id: ThreadId): Promise<AgentControlResult> {
    const child = this.deps.children.child(id);
    if (!child) return { ok: false, code: "not_found" };
    try {
      await this.deps.directory.call(
        child.machine,
        await this.origin(child.parentThreadId),
        { op: "cancel", threadId: id },
        { timeoutMs: 15_000 },
      );
    } catch (error) {
      throw this.deps.directory.controlError(child.machine, error);
    }
    return { ok: true };
  }
  /**
   * Follow-up work for a child there. The target keys the message by requestId, so a retry after
   * a dropped connection never sends it twice. An offline machine or one that refuses is an
   * error naming what to do, never a silent drop.
   */
  async message(id: ThreadId, message: MachineMessage): Promise<AgentControlResult> {
    const child = this.deps.children.child(id);
    if (!child) return { ok: false, code: "not_found" };
    const origin = await this.origin(child.parentThreadId);
    let lost: MachineFailure | undefined;
    for (let attempt = 0; ; attempt++)
      try {
        const answer = MachineMessageResult.parse(
          await this.deps.directory.call(
            child.machine,
            origin,
            { op: "message", threadId: id, ...message },
            { timeoutMs: 15_000 },
          ),
        );
        // A settled child given more work is working again until its next result.
        this.deps.children.reopen(id);
        return { ok: true, data: answer };
      } catch (error) {
        const dropped = error instanceof MachineFailure && error.kind === "disconnected";
        if (dropped) lost = error;
        if (attempt === 0 && dropped) continue;
        // Only a machine that never took the call or refused it outright proves nothing ran. A
        // lost reply may follow a message the child is already working on: it stays watched,
        // and if nothing changed there, the next poll settles it again under the same result.
        if (lost || !(error instanceof MachineFailure)) this.deps.children.reopen(id);
        // The parent hears the call was lost, not that the machine never had it.
        throw this.deps.directory.controlError(child.machine, lost ?? error);
      }
  }
  async status(
    machine: string,
    parentThreadId: ThreadId,
    ids: readonly ThreadId[],
  ): Promise<MachineThreadView[]> {
    const answer = await this.deps.directory.call(
      machine,
      await this.origin(parentThreadId),
      { op: "status", threadIds: [...ids] },
      { timeoutMs: 10_000 },
    );
    return MachineStatusResult.parse(answer).threads;
  }
  async respond(
    entry: { machine: string; parentThreadId: ThreadId; remote: MachinePendingRequest },
    resolution: InteractionResolution,
  ): Promise<void> {
    await this.deps.directory.call(
      entry.machine,
      await this.origin(entry.parentThreadId),
      {
        op: "respond",
        threadId: entry.remote.threadId,
        interactionId: entry.remote.interactionId,
        resolution,
      },
      { timeoutMs: 15_000 },
    );
  }
  /**
   * A browser tool on another machine. While it runs, that machine's requests for this call
   * (a private takeover there) show here too, so the person can answer from either one.
   */
  async browser(
    caller: McpAttribution,
    machine: string,
    tool: string,
    args: Record<string, unknown>,
    options: { timeoutMs: number; signal: AbortSignal },
  ) {
    const { directory } = this.deps;
    const origin = await this.origin(caller.threadId);
    let session: ThreadId;
    try {
      session = MachineSessionResult.parse(
        await directory.call(machine, origin, { op: "browser.session" }, { timeoutMs: 15_000 }),
      ).threadId;
    } catch (error) {
      throw directory.toolError(machine, error);
    }
    const source = `browser:${caller.threadId}:${session}`;
    const name = directory.label(machine);
    let stop: (() => void) | undefined;
    let done = false;
    const watch = () => {
      stop = this.deps.schedule(this.deps.pollMs, () => {
        void this.status(machine, caller.threadId, [session])
          .then(([view]) => {
            if (!done)
              this.deps.mirror.sync(source, caller.threadId, machine, name, view?.requests ?? []);
          })
          .catch(() => {})
          .finally(() => {
            if (!done) watch();
          });
      });
    };
    watch();
    try {
      return MachineToolResult.parse(
        await directory.call(
          machine,
          origin,
          { op: "browser", tool, args },
          { timeoutMs: options.timeoutMs, signal: options.signal, maxBytes: 8 * 1024 * 1024 },
        ),
      );
    } catch (error) {
      options.signal.throwIfAborted();
      throw directory.toolError(machine, error);
    } finally {
      done = true;
      stop?.();
      this.deps.mirror.release(source);
    }
  }
}
