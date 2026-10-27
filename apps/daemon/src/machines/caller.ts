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
import type { Answer, ResendAnswer } from "./child-messages.ts";
import type { RequestMirror } from "./mirror.ts";
import { MachineFailure } from "./transport.ts";

/**
 * A refusal the target recorded before the message ever reached its thread (its access or
 * ownership check, a deleted thread). The target checks that record before admitting any copy,
 * so none ever runs: the message is answered without reopening the child (ADR 0099).
 */
function rejectedBeforeArrival(error: unknown): error is MachineFailure {
  return (
    error instanceof MachineFailure &&
    error.kind === "refused" &&
    error.final &&
    (error.refusal === "machine_opted_out" ||
      error.refusal === "machine_forbidden" ||
      error.refusal === "not_found")
  );
}

export interface CallerDeps {
  store: Store;
  hostId: string;
  hostName(): Promise<string>;
  directory: MachineDirectory;
  children: MachineChildren;
  mirror: RequestMirror;
  schedule(ms: number, run: () => void): () => void;
  pollMs: number;
  /** The calling thread's ceiling, sent so the target applies it too (ADR 0105). */
  ceiling(threadId: ThreadId): "read" | "operate";
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
      ceiling: this.deps.ceiling(threadId),
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
    // The pairing the child is delegated through: once it is gone, the child can't be reached.
    const device = this.deps.directory.device(machine);
    const call = {
      op: "delegate" as const,
      requestId: request.requestId,
      ...(request.project ? { project: request.project } : {}),
      task: request.task,
      role: request.role,
      provider: request.provider,
      ...(request.model ? { model: request.model } : {}),
    };
    let answer: { threadId: ThreadId; title: string; queued?: boolean | undefined } | undefined;
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
      queued: answer.queued === true,
      device,
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
    if (child.abandoned)
      throw new AgentControlError(
        "invalid_arguments",
        "Child no longer tracked",
        undefined,
        "The person stopped tracking this child: its machine is no longer paired. Delegate a new task instead.",
      );
    const origin = await this.origin(child.parentThreadId);
    // Saved before it leaves: until the machine answers for it, no status reply settles the
    // child, and after a restart or a lost reply it is sent again under the same request id.
    const release = this.deps.children.send(id, message);
    const outcome: { answer?: Answer } = {};
    try {
      return await this.sendMessage(id, child.machine, origin, message, outcome);
    } finally {
      release(outcome.answer);
    }
  }
  /**
   * The same message again, after a restart or a lost reply: the target runs a request id at most
   * once and answers for it. Only a refusal the target recorded for the request id (final) also
   * answers for it: a refusal of this attempt alone (its access check, an engine still starting)
   * says nothing about a copy still on its way, so it throws like a machine that can't be reached.
   */
  async resend(
    machine: string,
    parentThreadId: ThreadId,
    id: ThreadId,
    message: MachineMessage,
  ): Promise<ResendAnswer> {
    try {
      MachineMessageResult.parse(
        await this.deps.directory.call(
          machine,
          await this.origin(parentThreadId),
          { op: "message", threadId: id, ...message },
          { timeoutMs: 15_000 },
        ),
      );
      return "taken";
    } catch (error) {
      if (rejectedBeforeArrival(error)) return { rejected: error.message };
      if (error instanceof MachineFailure && error.kind === "refused" && error.final)
        return "decided";
      throw error;
    }
  }
  private async sendMessage(
    id: ThreadId,
    machine: string,
    origin: MachineCallOrigin,
    message: MachineMessage,
    outcome: { answer?: Answer },
  ): Promise<AgentControlResult> {
    let lost: MachineFailure | undefined;
    for (let attempt = 0; ; attempt++)
      try {
        const answer = MachineMessageResult.parse(
          await this.deps.directory.call(
            machine,
            origin,
            { op: "message", threadId: id, ...message },
            { timeoutMs: 15_000 },
          ),
        );
        // A settled child given more work is working again until its next result: the release
        // reopens it as it drops the message's record.
        outcome.answer = "taken";
        return { ok: true, data: answer };
      } catch (error) {
        const dropped = error instanceof MachineFailure && error.kind === "disconnected";
        if (dropped) lost = error;
        if (attempt === 0 && dropped) continue;
        // Only a machine that never took the call or refused it outright proves nothing ran. A
        // lost reply may follow a message the child is already working on: it stays watched,
        // and if nothing changed there, the next poll settles it again under the same result.
        // A rejection recorded before it reached the child answers for it: no copy ever runs.
        // Any other refusal the target recorded for the request id answers for it whatever came
        // before: every copy of it gets the same answer.
        const rejected = rejectedBeforeArrival(error);
        if (rejected) outcome.answer = "refused";
        else if (error instanceof MachineFailure && error.final) outcome.answer = "decided";
        else if (lost || !(error instanceof MachineFailure)) this.deps.children.reopen(id);
        // A first attempt never reached, or refused, answered for the message: it never runs.
        else outcome.answer = "refused";
        // The parent hears the call was lost, not that the machine never had it.
        throw this.deps.directory.controlError(machine, rejected ? error : (lost ?? error));
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
   * A command tool on another machine (ADR 0105). Commands always act, so a read-only thread
   * here is refused before anything is sent; the target applies the same ceiling.
   */
  async command(
    caller: McpAttribution,
    machine: string,
    tool: string,
    args: Record<string, unknown>,
    options: { timeoutMs: number; signal: AbortSignal },
  ) {
    const { directory } = this.deps;
    if (this.deps.ceiling(caller.threadId) === "read")
      throw directory.toolError(
        machine,
        new MachineFailure(
          "refused",
          "machine_forbidden",
          "This thread is read-only, so it can't run commands on another machine.",
        ),
      );
    const origin = { ...(await this.origin(caller.threadId)), agentId: caller.agentId };
    try {
      return MachineToolResult.parse(
        await directory.call(
          machine,
          origin,
          { op: "commands", tool, args },
          { timeoutMs: options.timeoutMs, signal: options.signal, maxBytes: 2 * 1024 * 1024 },
        ),
      );
    } catch (error) {
      options.signal.throwIfAborted();
      throw directory.toolError(machine, error);
    }
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
    // Each calling agent holds its own leases there (ADR 0105).
    const origin = { ...(await this.origin(caller.threadId)), agentId: caller.agentId };
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
