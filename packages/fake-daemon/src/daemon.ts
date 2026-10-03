import type { Fact, Key } from "@ace/core";
import { applyThreadListEvent, createThreadListView } from "@ace/projection";
import {
  EventId,
  HostId,
  ThreadId,
  WorkspaceId,
  type Command,
  type CommandResult,
  type DeliveryEvent,
  type EventPayload,
  type InteractionResolution,
  type ItemsPage,
  type ProviderKind,
  type ThreadView,
  type SubscriptionScope,
  type ThreadListView,
} from "@ace/protocol";
import { Connection, matches, type Host, type Wire } from "./connection.ts";
import { fakeHealth } from "./health.ts";
import { ThreadHost } from "./thread-host.ts";
import { historyPage, windowSnapshot } from "./window.ts";
import {
  drainQueue,
  interruptFacts,
  sendFacts,
  startTurn,
  stopTaskFacts,
  type ThreadCommandOutcome,
} from "./thread-commands.ts";

export interface FakeDaemonOptions {
  /** Injected clock for event timestamps and core facts. */
  clock(): number;
  /** Credential the hello must present. */
  token?: string;
  /** Snapshot item window (ADR 0006 default is 200). */
  snapshotItems?: number;
}
export interface ThreadInit {
  id: string;
  workspaceId: string;
  title: string;
  provider: ProviderKind;
}
type ResolvedListener = (threadId: string, key: Key, resolution?: InteractionResolution) => void;

/**
 * In-memory daemon speaking the real wire protocol. Scripted adapter facts go through
 * `@ace/core`, so thread and agent status are derived exactly as the daemon derives them.
 */
export class FakeDaemon implements Host {
  readonly hostId = HostId.parse("fake-host");
  /** Fault injection: deliver every event frame twice. */
  duplicateEvents = false;
  private options: FakeDaemonOptions;
  private seq = 0;
  private log: DeliveryEvent[] = [];
  private threads = new Map<string, ThreadHost>();
  private list: ThreadListView = createThreadListView();
  private connections = new Set<Connection>();
  private receipts = new Map<string, CommandResult>();
  private resolvedListeners = new Set<ResolvedListener>();
  constructor(options: FakeDaemonOptions) {
    this.options = options;
  }
  get head(): number {
    return this.seq;
  }
  get token(): string {
    return this.options.token ?? "fake-token";
  }
  accepts(credential: { token?: string | undefined; ticket?: string | undefined }): boolean {
    return credential.token === this.token;
  }
  createThread(init: ThreadInit): void {
    if (this.threads.has(init.id)) throw new Error(`Thread ${init.id} already exists`);
    const now = this.options.clock();
    const thread = {
      id: ThreadId.parse(init.id),
      workspaceId: WorkspaceId.parse(init.workspaceId),
      title: init.title,
      provider: init.provider,
      status: { state: "new" as const },
      createdAt: now,
      updatedAt: now,
    };
    const host = new ThreadHost(thread);
    this.threads.set(init.id, host);
    this.append(host, [{ type: "thread.created", thread }], now);
  }
  /** Apply adapter facts to a thread and publish the resulting events as one batch. */
  apply(threadId: string, facts: readonly Fact[]): void {
    const host = this.thread(threadId);
    const now = this.options.clock();
    const payloads = facts.flatMap((fact) => host.fold(fact, now));
    // A queued message starts the next turn as soon as the root agent is free.
    const drained = facts.length ? drainQueue(host) : [];
    this.append(host, [...payloads, ...drained.flatMap((fact) => host.fold(fact, now))], now);
  }
  private append(host: ThreadHost, payloads: EventPayload[], now: number): void {
    if (!payloads.length) return;
    const events = payloads.map((payload) => {
      const seq = ++this.seq;
      const event: DeliveryEvent = {
        seq,
        id: EventId.parse(`event-${seq}`),
        at: now,
        threadId: ThreadId.parse(host.id),
        payload,
      };
      this.log.push(event);
      host.record(event);
      applyThreadListEvent(this.list, event);
      return event;
    });
    for (const connection of this.connections) connection.publish(events, this.seq);
  }
  private thread(id: string): ThreadHost {
    const host = this.threads.get(id);
    if (!host) throw new Error(`Unknown thread ${id}`);
    return host;
  }
  isPending(threadId: string, key: Key): boolean {
    return this.thread(threadId).interaction(key)?.state === "pending";
  }
  resolution(threadId: string, key: Key): InteractionResolution | undefined {
    return this.thread(threadId).interaction(key)?.resolution;
  }
  onResolved(listener: ResolvedListener): () => void {
    this.resolvedListeners.add(listener);
    return () => this.resolvedListeners.delete(listener);
  }
  connect(wire: Wire): Connection {
    const connection = new Connection(this, wire);
    this.connections.add(connection);
    return connection;
  }
  release(connection: Connection): void {
    this.connections.delete(connection);
  }
  /** Drop every socket, as a daemon restart or network loss would. */
  disconnectAll(code = 1006): void {
    // Deleting the current entry during Set iteration is safe.
    for (const connection of this.connections) connection.close(code);
  }
  snapshot(scope: SubscriptionScope): ThreadView | ThreadListView | undefined {
    if (scope.kind === "threads") return { ...structuredClone(this.list), seq: this.seq };
    const host = this.threads.get(scope.threadId);
    return host
      ? windowSnapshot(host.view, host.creation, this.options.snapshotItems ?? 200, this.seq)
      : undefined;
  }
  replay(scope: SubscriptionScope, afterSeq: number): DeliveryEvent[] {
    return this.log.filter((event) => event.seq > afterSeq && matches(scope, event));
  }
  page(threadId: string, before: number, limit: number): ItemsPage | undefined {
    const host = this.threads.get(threadId);
    return host ? historyPage(host.view, host.creation, before, limit, this.seq) : undefined;
  }
  command(command: Command): CommandResult {
    const previous = this.receipts.get(command.id);
    if (previous) return previous;
    const result = this.execute(command);
    this.receipts.set(command.id, result);
    return result;
  }
  private run(
    commandId: Command["id"],
    threadId: string,
    decide: (host: ThreadHost) => ThreadCommandOutcome,
  ): CommandResult {
    const host = this.threads.get(threadId);
    if (!host) return { commandId, ok: false, error: "thread_not_found" };
    const outcome = decide(host);
    if (!outcome.ok) return { commandId, ok: false, error: outcome.error };
    this.apply(threadId, outcome.facts);
    return { commandId, ok: true };
  }
  private execute(command: Command): CommandResult {
    const payload = command.payload;
    const commandId = command.id;
    switch (payload.type) {
      case "diagnostics.health":
        return { commandId, ok: true, health: fakeHealth(this.options.clock(), this.threads.size) };
      case "interaction.resolve": {
        for (const host of this.threads.values()) {
          const key = host.interactionKey(payload.interactionId);
          if (key === undefined) continue;
          if (host.interaction(key)?.state !== "pending")
            return { commandId, ok: false, error: "already_resolved" };
          this.apply(host.id, [
            {
              type: "interaction.closed",
              interaction: key,
              state: "resolved",
              resolution: payload.resolution,
              resolvedBy: command.deviceId,
            },
          ]);
          for (const listener of this.resolvedListeners) listener(host.id, key, payload.resolution);
          return { commandId, ok: true };
        }
        return { commandId, ok: false, error: "not_found" };
      }
      case "thread.create": {
        const threadId = `thread-${commandId}`;
        if (this.threads.has(threadId)) return { commandId, ok: true };
        this.createThread({
          id: threadId,
          workspaceId: payload.workspaceId,
          title: payload.title ?? "New thread",
          provider: payload.provider,
        });
        const host = this.thread(threadId);
        this.apply(threadId, [
          {
            type: "agent.seen",
            agent: "root",
            origin: "root",
            fidelity: "full",
            native: { provider: payload.provider, nativeId: "root" },
            cwd: `/Users/dev/${payload.workspaceId}`,
            ...(payload.model ? { model: payload.model } : {}),
          },
        ]);
        const text = payload.input.flatMap((part) => (part.type === "text" ? [part.text] : []));
        this.apply(threadId, startTurn(host, commandId, text.join("")));
        return { commandId, ok: true };
      }
      case "thread.send":
        return this.run(commandId, payload.threadId, (host) => sendFacts(host, commandId, payload));
      case "thread.interrupt":
        return this.run(commandId, payload.threadId, (host) =>
          interruptFacts(host, payload.agentId, payload.cascade),
        );
      case "background_task.stop": {
        for (const host of this.threads.values()) {
          const outcome = stopTaskFacts(host, payload.taskId);
          if (outcome) return this.run(commandId, host.id, () => outcome);
        }
        return { commandId, ok: false, error: "not_found" };
      }
      case "thread.archive": {
        const host = this.threads.get(payload.threadId);
        if (!host) return { commandId, ok: false, error: "thread_not_found" };
        const now = this.options.clock();
        this.append(host, [{ type: "thread.updated", archivedAt: now }], now);
        return { commandId, ok: true };
      }
      default:
        return { commandId, ok: false, error: "unsupported_by_fake_daemon" };
    }
  }
}
