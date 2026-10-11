import { admitDelegation } from "@ace/orchestrator";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  HostId,
  ThreadId,
  CommandId,
  type AgentControlResult,
  type McpAttribution,
  type RemoteAgentHost,
  type RemoteAgentOperation,
  type RemoteTask,
  type RemoteTaskReport,
  type ThreadId as ThreadKey,
} from "@ace/protocol";
import type { Store } from "../store.ts";
import type { Engine } from "../engine/index.ts";
import type { EngineClock } from "../engine/actor.ts";
import { RemoteTaskJournal } from "./remote-journal.ts";
import type { DelegationService } from "./delegations.ts";

export const remoteTerminal = (task: RemoteTask) =>
  ["completed", "failed", "cancelled"].includes(task.phase);
/** Volatile broker authority over a durable task ledger. No remote credentials enter the daemon. */
export class RemoteDelegations {
  readonly journal: RemoteTaskJournal;
  private broker:
    | {
        session: string;
        lease: string;
        hosts: RemoteAgentHost[];
        until: number;
        valid: () => boolean;
      }
    | undefined;
  private store: Store;
  private engine: Engine;
  private local: DelegationService;
  private now: () => number;
  private id: () => string;
  private admit: () => boolean;
  private hostId: string;
  private preparing = 0;
  private waiters = new Map<string, number>();
  private cancelTimer: (() => void) | undefined;
  private closed = false;
  private pruneAt = 0;
  private deliveryRetry = new Map<string, number>();
  private clock: EngineClock | undefined;
  private onError: (error: unknown) => void;
  private resolveArtifacts: ((task: RemoteTask) => Promise<unknown>) | undefined;
  private onReturnCancel: ((task: RemoteTask) => void) | undefined;
  private pendingArtifacts:
    | ((task: RemoteTask) => import("@ace/protocol").RemoteArtifactManifest | undefined)
    | undefined;
  private artifactReady:
    | ((task: RemoteTask, artifacts: import("@ace/protocol").RemoteArtifactManifest) => boolean)
    | undefined;
  private prepareContext:
    | ((
        task: RemoteTask,
        signal: AbortSignal,
      ) => Promise<import("@ace/protocol").RemoteContextManifest>)
    | undefined;
  constructor(options: {
    resolveArtifacts?: (task: RemoteTask) => Promise<unknown>;
    onReturnCancel?: (task: RemoteTask) => void;
    pendingArtifacts?: (
      task: RemoteTask,
    ) => import("@ace/protocol").RemoteArtifactManifest | undefined;
    artifactReady?: (
      task: RemoteTask,
      artifacts: import("@ace/protocol").RemoteArtifactManifest,
    ) => boolean;
    prepareContext?: (
      task: RemoteTask,
      signal: AbortSignal,
    ) => Promise<import("@ace/protocol").RemoteContextManifest>;
    clock?: EngineClock;
    onError?: (error: unknown) => void;
    hostId: string;
    store: Store;
    engine: Engine;
    local: DelegationService;
    now: () => number;
    id: () => string;
    admit: () => boolean;
  }) {
    this.resolveArtifacts = options.resolveArtifacts;
    this.onReturnCancel = options.onReturnCancel;
    this.pendingArtifacts = options.pendingArtifacts;
    this.artifactReady = options.artifactReady;
    this.clock = options.clock;
    this.onError = options.onError ?? (() => {});
    this.prepareContext = options.prepareContext;
    this.store = options.store;
    this.engine = options.engine;
    this.local = options.local;
    this.now = options.now;
    this.id = options.id;
    this.admit = options.admit;
    this.hostId = options.hostId;
    this.journal = new RemoteTaskJournal(this.store);
    this.journal.prune(this.now());
    this.engine.bindRemoteTaskStop((id) => this.stopTask(id));
    for (const task of this.journal.active())
      if (!remoteTerminal(task) && this.store.getThread(task.parentThreadId))
        this.engine.remoteDelegation(task);
    this.arm();
  }
  close() {
    this.closed = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.broker = undefined;
  }
  private arm() {
    if (this.closed || this.cancelTimer || !this.clock || !this.journal.active().length) return;
    this.cancelTimer = this.clock.setTimer(() => {
      this.cancelTimer = undefined;
      try {
        this.drain();
      } catch (error) {
        this.onError(error);
      } finally {
        this.arm();
      }
    }, 1000);
  }
  /** Policy deadlines remain enforced while the client or target device is disconnected. */
  drain() {
    if (this.closed) return;
    this.store.atomic(() => {
      if (this.now() >= this.pruneAt) {
        this.journal.prune(this.now());
        this.pruneAt = this.now() + 60000;
      }
      for (const task of this.journal.active()) {
        if (!remoteTerminal(task)) {
          this.revalidate(task);
          if (!task.dispatched && task.phase === "cancelling") task.phase = "cancelled";
          this.journal.save(task);
        }
        this.finish(task);
      }
    });
  }
  private admission(parent: ThreadKey) {
    const tasks = this.journal.active();
    if (
      tasks.length >= 64 ||
      this.local.journal.ancestorStopped(parent) ||
      this.local.journal.stopped(parent)
    )
      return undefined;
    const tree = this.local.journal.tree(parent, this.now());
    const remote = this.journal.root(tree.root);
    return admitDelegation(
      {
        ...tree,
        children: tree.children + remote.children,
        usage: {
          tokens: tree.usage.tokens + remote.usage.tokens,
          cost: tree.usage.cost + remote.usage.cost,
        },
        concurrent:
          this.local.journal.concurrent(parent) +
          tasks.filter((task) => task.parentThreadId === parent).length,
      },
      this.local.policy,
      this.now(),
    )
      ? undefined
      : tree;
  }
  register(session: string, hosts: RemoteAgentHost[], valid: () => boolean): string | undefined {
    const broker = this.current();
    if (broker && broker.session !== session) return undefined;
    if (!valid()) return undefined;
    this.broker = {
      session,
      lease: broker?.lease ?? this.id(),
      hosts,
      until: this.now() + 15000,
      valid,
    };
    return this.broker.lease;
  }
  disconnect(session: string) {
    if (this.broker?.session === session) this.broker = undefined;
  }
  private current() {
    const broker = this.broker;
    if (broker && (broker.until <= this.now() || !broker.valid())) this.broker = undefined;
    return this.broker;
  }
  owns(session: string, lease: string): boolean {
    const b = this.current();
    return b?.session === session && b.lease === lease;
  }
  returnTask(session: string, lease: string, id: string): RemoteTask | undefined {
    if (!this.owns(session, lease)) return;
    const task = this.journal.get(id);
    if (!task || !task.dispatched || remoteTerminal(task)) return;
    this.revalidate(task);
    this.journal.save(task);
    if (task.phase === "cancelling") {
      this.onReturnCancel?.(task);
      return;
    }
    return task;
  }
  poll(session: string, lease: string): RemoteTask[] | undefined {
    if (!this.owns(session, lease)) return undefined;
    return this.store.atomic(() =>
      this.journal.active().map((task) => {
        this.revalidate(task);
        if (remoteTerminal(task)) {
          this.finish(task);
          return task;
        }
        if (!task.dispatched && task.phase === "cancelling") {
          task.phase = "cancelled";
          this.journal.save(task);
          this.finish(task);
          return task;
        }
        // Claim before routing. Retrying always uses the same remote thread and command identities.
        task.dispatched = true;
        this.journal.save(task);
        return task;
      }),
    );
  }
  report(session: string, lease: string, report: RemoteTaskReport): RemoteTask | undefined {
    if (!this.owns(session, lease)) return undefined;
    return this.store.atomic(() => {
      const task = this.journal.get(report.taskId);
      if (!task || !task.dispatched) return undefined;
      if (remoteTerminal(task)) {
        // A sealed answer may arrive after a cancellation deadline or failed admission report.
        // Keep the terminal fence, but deliver that first answer even if failure was already sent.
        if (
          task.result === undefined &&
          report.result !== undefined &&
          ["completed", "failed", "cancelled"].includes(report.phase)
        ) {
          task.result = report.result;
          task.truncated = report.truncated;
          task.artifactsUnavailable = report.artifactsUnavailable;
          if (report.error)
            task.error = [task.error, report.error].filter(Boolean).join(" ").slice(0, 256);
          task.delivered = false;
          this.journal.save(task);
        }
        this.finish(task);
        return task;
      }
      this.revalidate(task);
      if (
        task.phase !== "cancelling" &&
        ["completed", "failed"].includes(report.phase) &&
        this.pendingArtifacts?.(task) &&
        !report.artifacts &&
        !report.artifactsUnavailable
      )
        return undefined;
      if (report.artifacts && task.phase !== "cancelling") {
        if (!this.artifactReady?.(task, report.artifacts)) return undefined;
        task.artifacts = report.artifacts;
      }
      // Cancellation cannot be undone by a stale progress or completion report.
      task.phase =
        task.phase === "cancelling" && !["cancelled", "failed"].includes(report.phase)
          ? "cancelling"
          : report.phase;
      if (task.phase === "cancelling") task.cancellingAt ??= this.now();
      if (report.usage)
        task.usage = {
          tokens: Math.max(task.usage.tokens, report.usage.tokens),
          cost: Math.max(task.usage.cost, report.usage.cost),
        };
      if (report.truncated !== undefined) task.truncated = report.truncated;
      if (report.artifactsUnavailable) {
        task.artifactsUnavailable = true;
        this.onReturnCancel?.(task);
      }
      if (report.result !== undefined) task.result = report.result;
      if (report.error !== undefined) task.error = report.error;
      this.journal.save(task);
      this.finish(task);
      return task;
    });
  }
  private revalidate(task: RemoteTask) {
    if (task.phase === "cancelling") {
      task.cancellingAt ??= this.now();
      if (this.now() - task.cancellingAt >= 30000) {
        task.phase = "failed";
        task.error = "Cancellation could not be confirmed. The remote task may still be running.";
      }
      return;
    }
    const parent = this.store.getThread(task.parentThreadId);
    if (!parent || parent.deletedAt !== undefined) {
      task.phase = "cancelling";
      task.cancellingAt ??= this.now();
      return;
    }
    const tree = this.local.journal.tree(task.parentThreadId, this.now());
    const remote = this.journal.root(tree.root);
    if (
      !parent ||
      parent.provider !== task.parentProvider ||
      this.engine.permissionMode(parent.id) !== task.parentPermissionMode ||
      (parent.permission?.override ?? null) !== task.parentPermissionOverride ||
      this.local.journal.stopped(parent.id) ||
      this.local.journal.ancestorStopped(parent.id) ||
      this.now() - tree.startedAt >= this.local.policy.durationMs ||
      tree.usage.tokens + remote.usage.tokens >= this.local.policy.tokens ||
      tree.usage.cost + remote.usage.cost >= this.local.policy.cost
    ) {
      task.phase = "cancelling";
      task.cancellingAt ??= this.now();
    }
  }
  private finish(task: RemoteTask) {
    if (["cancelling", "cancelled"].includes(task.phase)) this.onReturnCancel?.(task);
    if (!remoteTerminal(task) || task.delivered) return;
    task.finishedAt ??= this.now();
    this.journal.save(task);
    if ((this.deliveryRetry.get(task.id) ?? 0) > this.now()) return;
    try {
      this.store.atomic(() => {
        const parent = this.store.getThread(task.parentThreadId);
        if (parent && parent.deletedAt === undefined) {
          this.engine.remoteDelegation(task);
          // Results are context on the originating host, with explicit remote identity.
          if (this.waiters.has(task.id)) return;
          if (task.phase !== "cancelled" || task.result !== undefined) {
            const answer =
              ["failed", "cancelled"].includes(task.phase) && task.result !== undefined
                ? ":answer"
                : "";
            const commandId = CommandId.parse(`remote-result:${task.id}${answer}`);
            const text = `[ace remote task ${task.id}; host ${task.request.hostId}; thread ${task.threadId}; ${task.phase}]\n${task.result ?? task.error ?? "No text result returned."}${task.truncated ? "\n[Remote answer truncated.]" : ""}${task.result && task.error ? `\n${task.error}` : ""}\n${task.artifacts?.attachments.length ? "Published images/files are attached as immutable copies on this source device. Their producing host/thread remain in the task provenance." : "No files were published for this task."} No workspace changes are overwritten or merged.`;
            const result = this.local.command(commandId, {
              type: "thread.send",
              threadId: task.parentThreadId,
              input: [{ type: "text", text }],
              ...(task.artifacts?.attachments.length
                ? {
                    context: {
                      mentions: [],
                      attachments: task.artifacts.attachments.map((file) => ({
                        sha256: file.sha256,
                      })),
                    },
                  }
                : {}),
              delivery: "queue",
              trigger: "subagent_result",
              origin: { kind: "subagent_result" },
            });
            if (!result.ok) throw new Error("Remote result delivery unavailable");
          }
        }
        task.delivered = true;
        this.journal.save(task);
      });
      this.deliveryRetry.delete(task.id);
    } catch (error) {
      this.deliveryRetry.set(task.id, this.now() + 5000);
      this.onError(error);
    }
  }
  retains(parent: string, hash: string): boolean {
    return this.journal
      .active()
      .some(
        (task) =>
          task.parentThreadId === parent &&
          task.context?.attachments.some((attachment) => attachment.sha256 === hash),
      );
  }
  cancelTree(parent: ThreadKey) {
    this.store.atomic(() => {
      for (const task of this.journal.active())
        if (
          task.parentThreadId === parent ||
          this.local.journal.isDescendant(task.parentThreadId, parent)
        ) {
          if (remoteTerminal(task)) {
            this.finish(task);
            continue;
          }
          task.phase = task.dispatched ? "cancelling" : "cancelled";
          task.cancellingAt ??= this.now();
          this.journal.save(task);
          this.engine.remoteDelegation(task);
          this.finish(task);
        }
    });
  }
  stopTask(id: string) {
    const task = this.journal.get(id);
    if (!task || remoteTerminal(task)) return;
    task.phase = task.dispatched ? "cancelling" : "cancelled";
    task.cancellingAt ??= this.now();
    this.journal.save(task);
    this.engine.remoteDelegation(task);
    this.finish(task);
  }
  async execute(
    caller: McpAttribution,
    operation: RemoteAgentOperation,
    signal: AbortSignal,
  ): Promise<AgentControlResult> {
    signal.throwIfAborted();
    if (!this.store.getMcpAgent(caller.threadId, caller.agentId))
      return { ok: false, code: "forbidden" };
    if (operation.op === "device.task_publish") return { ok: false, code: "unsupported" };
    if (operation.op === "device.list")
      return {
        ok: true,
        data: { hosts: this.current()?.hosts ?? [], requiresConnectedClient: true },
      };
    if (operation.op === "device.delegate") {
      if (!this.admit()) return { ok: false, code: "not_ready" };
      const { op: _op, ...request } = operation;
      const id = createHash("sha256")
        .update(JSON.stringify([this.hostId, caller.threadId, request.requestId]))
        .digest("hex");
      const receipt = this.journal.get(id);
      if (receipt)
        return receipt.parentAgentId === caller.agentId &&
          JSON.stringify(receipt.request) === JSON.stringify(request)
          ? { ok: true, data: receipt }
          : { ok: false, code: "invalid" };
      const parent = this.store.getThread(caller.threadId);
      const broker = this.current();
      const host = broker?.hosts.find((candidate) => candidate.hostId === request.hostId);
      const agent = host?.agents.find(
        (candidate) =>
          candidate.provider === request.provider &&
          candidate.model === request.model &&
          candidate.accountId === request.accountId &&
          candidate.instanceId === request.instanceId &&
          candidate.installationId === request.installationId &&
          candidate.acpAgentId === request.acpAgentId,
      );
      if (
        !parent ||
        !host?.projects.some((project) => project.workspaceId === request.workspaceId) ||
        !agent
      )
        return { ok: false, code: "unavailable" };
      // Native policies have no cross-provider ordering. Reuse the exact parent policy on the
      // same provider; cross-provider delegates are restricted to a native low-risk policy.
      const inherited = this.engine.permissionMode(parent.id);
      const mode = agent.permissionModes.find(
        (candidate) =>
          (request.permissionMode
            ? candidate.id === request.permissionMode
            : request.provider === parent.provider && inherited !== null
              ? candidate.id === inherited
              : candidate.risk === "low") &&
          (request.provider === parent.provider && inherited !== null
            ? candidate.id === inherited
            : candidate.risk === "low"),
      );
      if (!mode) return { ok: false, code: "forbidden" };
      const tree = this.admission(parent.id);
      if (!tree) return { ok: false, code: "limit" };
      const incoming = this.store.atomic((db) =>
        db.prepare("SELECT name FROM sqlite_master WHERE name='remote_agent_incoming'").get(),
      );
      if (
        incoming &&
        this.store.atomic((db) =>
          db.prepare("SELECT id FROM remote_agent_incoming WHERE thread_id=?").get(tree.root),
        )
      )
        return { ok: false, code: "forbidden" };
      const task: RemoteTask = {
        id,
        sourceHostId: HostId.parse(this.hostId),
        rootThreadId: tree.root,
        parentProvider: parent.provider,
        parentPermissionMode: inherited,
        parentPermissionOverride: parent.permission?.override ?? null,
        parentThreadId: caller.threadId,
        parentAgentId: caller.agentId,
        threadId: ThreadId.parse(`remote-${id}`),
        request,
        permissionMode: mode.id,
        usage: { tokens: 0, cost: 0 },
        phase: "queued",
        dispatched: false,
        delivered: false,
        createdAt: this.now(),
      };
      if (this.preparing >= 4) return { ok: false, code: "limit" };
      this.preparing++;
      try {
        if (this.prepareContext) task.context = await this.prepareContext(task, signal);
        else if (request.context) return { ok: false, code: "not_ready" };
      } catch {
        signal.throwIfAborted();
        return { ok: false, code: "unavailable" };
      } finally {
        this.preparing--;
      }
      signal.throwIfAborted();
      if (
        !this.admit() ||
        !this.store.getMcpAgent(caller.threadId, caller.agentId) ||
        !this.current()?.hosts.some((candidate) => candidate.hostId === request.hostId) ||
        this.engine.permissionMode(parent.id) !== inherited ||
        (this.store.getThread(parent.id)?.permission?.override ?? null) !==
          task.parentPermissionOverride
      )
        return { ok: false, code: "forbidden" };
      const duplicate = this.journal.get(id);
      if (duplicate)
        return duplicate.parentAgentId === caller.agentId &&
          JSON.stringify(duplicate.request) === JSON.stringify(request)
          ? { ok: true, data: duplicate }
          : { ok: false, code: "invalid" };
      if (!this.admission(parent.id)) return { ok: false, code: "limit" };
      this.store.atomic(() => {
        this.journal.save(task);
        this.engine.remoteDelegation(task);
      });
      this.arm();
      return { ok: true, data: task };
    }
    let task = this.journal.get(operation.taskId);
    if (!task) return { ok: false, code: "not_found" };
    if (task.parentThreadId !== caller.threadId || task.parentAgentId !== caller.agentId)
      return { ok: false, code: "forbidden" };
    if (operation.op === "device.task_cancel" && !remoteTerminal(task)) {
      task.phase = task.dispatched ? "cancelling" : "cancelled";
      task.cancellingAt ??= this.now();
      const cancelled = task;
      this.store.atomic(() => {
        this.journal.save(cancelled);
        this.engine.remoteDelegation(cancelled);
        this.finish(cancelled);
      });
    }
    if (operation.op === "device.task_wait") {
      this.waiters.set(task.id, (this.waiters.get(task.id) ?? 0) + 1);
      try {
        while (!remoteTerminal(task)) {
          await delay(250, undefined, { signal });
          task = this.journal.get(operation.taskId);
          if (!task) return { ok: false, code: "not_found" };
        }
        task.delivered = true;
        this.journal.save(task);
      } finally {
        const remaining = (this.waiters.get(operation.taskId) ?? 1) - 1;
        if (remaining) this.waiters.set(operation.taskId, remaining);
        else this.waiters.delete(operation.taskId);
        const current = this.journal.get(operation.taskId);
        if (current) this.finish(current);
      }
    }
    const returnedFiles = task.artifacts?.attachments.length
      ? await this.resolveArtifacts?.(task)
      : undefined;
    signal.throwIfAborted();
    if (
      !this.store.getMcpAgent(caller.threadId, caller.agentId) ||
      this.store.getThread(caller.threadId)?.deletedAt !== undefined
    )
      return { ok: false, code: "forbidden" };
    return {
      ok: true,
      data: {
        ...task,
        ...(returnedFiles ? { returnedFiles } : {}),
        ...(!remoteTerminal(task) &&
        !this.current()?.hosts.some((host) => host.hostId === task.request.hostId)
          ? { phase: task.phase === "cancelling" ? "cancelling" : "unavailable" }
          : {}),
      },
    };
  }
}
