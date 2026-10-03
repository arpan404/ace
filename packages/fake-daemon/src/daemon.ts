import type { Fact, Key } from "@ace/core";
import {
  organizationCommands,
  organizationDecision,
  settleDecision,
  settlePolicy,
  liveMetadata,
  applyThreadListEvent,
  createThreadListView,
} from "@ace/projection";
import {
  AgentId,
  EventId,
  HostId,
  ThreadId,
  WorkspaceId,
  Thread,
  type ClientMessage,
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
  type ServerMessage,
} from "@ace/protocol";
import { Connection, matches, type Host, type Wire } from "./connection.ts";
import { fakeHealth } from "./health.ts";
import { FakeAccess } from "./access.ts";
import { FakeAppDevices } from "./app-devices.ts";
import { FakeReviewDesk } from "./review-desk.ts";
import { ThreadHost } from "./thread-host.ts";
import { historyPage, windowSnapshot } from "./window.ts";
import { FakeServices } from "./services/index.ts";
import { FakeServicesWire, type FakeWireSession, type ServicesSeed } from "./services-wire.ts";
import { FakeOutputStore } from "./output-store.ts";
import type { FakeBrowser } from "./browser.ts";
import type { FakeTerminals } from "./terminals.ts";
import { startedThread } from "./scenarios/started-thread.ts";
import {
  drainQueue,
  interruptFacts,
  sendFacts,
  stopTaskFacts,
  type ThreadCommandOutcome,
} from "./thread-commands.ts";
import { holdOnLimit, isQueueCommand, queueCommand, queuePage } from "./queue-commands.ts";
import { forkPointError, switchEvents } from "./transitions.ts";

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
  details?: Thread["details"];
  live?: Thread["live"];
  lineage?: Thread["lineage"];
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
  private servicesWire: FakeServicesWire;
  private seq = 0;
  private log: DeliveryEvent[] = [];
  private threads = new Map<string, ThreadHost>();
  private list: ThreadListView = createThreadListView();
  private connections = new Set<Connection>();
  private receipts = new Map<string, { deviceId: Command["deviceId"]; result: CommandResult }>();
  private resolvedListeners = new Set<ResolvedListener>();
  private outputs = new FakeOutputStore();
  private faults = new Map<string, "fail" | "hold">();
  private refusing = false;
  /** Review mode sessions and comments; sent comments arrive in the thread as a user message. */
  readonly review: FakeReviewDesk;
  /** Accounts, usage, models, settings, search and slash commands, over the wire. */
  readonly services: FakeServices;
  /** The HTTP access routes: paired devices, pairing and revoking. */
  readonly access: FakeAccess;
  /** iOS Simulators and Android emulators, over a dedicated devices channel. */
  readonly appDevices: FakeAppDevices;
  constructor(options: FakeDaemonOptions) {
    this.options = options;
    this.access = new FakeAccess(options.clock);
    this.appDevices = new FakeAppDevices(options.clock);
    this.services = new FakeServices({
      clock: options.clock,
      thread: (threadId) => {
        const host = this.threads.get(threadId);
        return (
          host && { workspaceId: host.view.thread.workspaceId, provider: host.view.thread.provider }
        );
      },
    });
    this.servicesWire = new FakeServicesWire(
      {
        now: options.clock,
        thread: (id) => {
          const host = this.threads.get(id);
          return host?.view.thread.deletedAt === undefined ? host?.view : undefined;
        },
        threads: () => [...this.threads.values()].map((host) => host.view.thread),
        update: (id, payload) => this.append(this.thread(id), [payload], options.clock()),
      },
      this.services.settings,
    );
    this.review = new FakeReviewDesk(options.clock, (threadId, text) =>
      this.apply(threadId, [
        {
          type: "item.upsert",
          agent: "root",
          item: `review-${this.seq + 1}`,
          draft: { type: "message", role: "user", complete: true, parts: [{ type: "text", text }] },
        },
      ]),
    );
  }
  /** The PTYs clients reach through `terminal.request`, for seeding a scenario's terminals. */
  get terminals(): FakeTerminals {
    return this.servicesWire.workspace.terminals;
  }
  /** The browser and previews clients reach through `browser.*` and `preview.request`. */
  get browser(): FakeBrowser {
    return this.servicesWire.browser;
  }
  /**
   * Seed what a long-running daemon's services hold: decks, automations and their runs,
   * installed plugins and the forge's pull requests. Threads a seed links to must exist.
   */
  seedServices(seed: ServicesSeed): void {
    this.servicesWire.seed(seed);
  }
  session(send: (message: ServerMessage) => void): FakeWireSession {
    return this.servicesWire.session(send);
  }
  /** A page of a shell's full output (`output.read`), or undefined for an unknown stream. */
  output(streamId: string, offset: number, limit: number) {
    return this.outputs.read(streamId, offset, limit);
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
  /** The daemon's clock, `agoMs` back. Never before the epoch, whatever a script asks for. */
  private at(agoMs: number): number {
    return Math.max(0, this.options.clock() - agoMs);
  }
  createThread(init: ThreadInit, agoMs = 0): void {
    if (this.threads.has(init.id)) throw new Error(`Thread ${init.id} already exists`);
    const now = this.at(agoMs);
    const thread = {
      id: ThreadId.parse(init.id),
      workspaceId: WorkspaceId.parse(init.workspaceId),
      title: init.title,
      provider: init.provider,
      ...(init.details ? { details: init.details } : {}),
      ...(init.live ? { live: init.live } : {}),
      ...(init.lineage ? { lineage: init.lineage } : {}),
      activityAt: now,
      status: { state: "new" as const },
      createdAt: now,
      updatedAt: now,
    };
    const host = new ThreadHost(thread);
    this.threads.set(init.id, host);
    this.append(host, [{ type: "thread.created", thread }], now);
  }
  /**
   * Apply adapter facts to a thread and publish the resulting events as one batch, stamped
   * `agoMs` before now (scripts backdate seeded history).
   */
  apply(threadId: string, facts: readonly Fact[], agoMs = 0): void {
    const host = this.thread(threadId);
    const now = this.at(agoMs);
    const payloads = facts.flatMap((fact) => host.fold(fact, now));
    // A queued message starts the next turn as soon as the root agent is free.
    const drained = drainQueue(host);
    const selection = host.nextSelection;
    host.nextSelection = undefined;
    const selectionEvent: EventPayload[] = selection
      ? [
          {
            type: "thread.client.updated",
            changes: { live: { ...host.view.thread.live, ...selection } },
          },
        ]
      : [];
    this.append(
      host,
      [...selectionEvent, ...payloads, ...drained.flatMap((fact) => host.fold(fact, now))],
      now,
    );
    this.afterChange(host, now);
  }
  /**
   * What the daemon does once a thread changed: hold the queue on a usage limit, publish the
   * queue's new revision, apply a switch waiting for the turn to end, and settle on schedule.
   */
  private afterChange(host: ThreadHost, now: number): void {
    holdOnLimit(host);
    const follow: EventPayload[] = [...switchEvents(host, now)];
    if (host.queueDirty) {
      host.queueDirty = false;
      host.queue.revision++;
      follow.push({ type: "queue.updated", ...host.queue });
    }
    this.append(host, follow, now);
    this.settle(host, now);
  }
  private append(host: ThreadHost, payloads: EventPayload[], now: number): void {
    if (!payloads.length) return;
    const events: DeliveryEvent[] = [];
    const followups: EventPayload[] = [];
    let inputIndex = 0;
    while (followups.length || inputIndex < payloads.length) {
      const payload = followups.shift() ?? payloads[inputIndex++];
      if (!payload) continue;
      const metadata = liveMetadata(
        host.view.thread,
        payload,
        payload.type === "agent.created" ? host.view.agents[payload.agent.id] : undefined,
        payload.type === "background_task.started"
          ? host.view.backgroundTasks[payload.task.id]
          : payload.type === "background_task.updated"
            ? host.view.backgroundTasks[payload.taskId]
            : undefined,
      );
      if (metadata) followups.push(metadata);
      // The daemon turns a provider's context sample into the agent's replaceable meter.
      if (payload.type === "context.sampled")
        followups.push({
          type: "context_meter.updated",
          meter: {
            agentId: payload.agentId,
            epoch: (host.view.contextMeters?.[payload.agentId]?.epoch ?? 0) + 1,
            usedTokens: payload.usedTokens,
            windowTokens: payload.windowTokens ?? null,
            ...(payload.model ? { model: payload.model } : {}),
            source: "provider",
          },
        });
      if (payload.type === "thread.updated" && payload.status)
        followups.push({
          type: "thread.client.updated",
          changes: { activityAt: now },
        });
      this.outputs.record(payload);
      const seq = ++this.seq;
      const event: DeliveryEvent = {
        seq,
        id: EventId.parse(`event-${seq}`),
        at: now,
        threadId: ThreadId.parse(host.id),
        payload,
      };
      if (
        event.payload.type === "run.started" &&
        event.payload.run.agentId === host.view.thread.rootAgentId
      ) {
        const run = event.payload.run;
        event.payload = {
          ...event.payload,
          run: {
            ...run,
            ordinal: host.view.runs[run.id]?.ordinal ?? ++host.runOrdinal,
            checkpoints: { state: "unavailable", error: "scripted_provider" },
          },
        };
      }
      this.log.push(event);
      host.record(event);

      applyThreadListEvent(this.list, event);
      events.push(event);
    }
    for (const connection of this.connections) connection.publish(events, this.seq);
  }
  private thread(id: string): ThreadHost {
    const host = this.threads.get(id);
    if (!host) throw new Error(`Unknown thread ${id}`);
    return host;
  }
  /** The daemon item id a script's adapter key became, for seeding client-side state. */
  itemId(threadId: string, key: Key): string | undefined {
    const host = this.threads.get(threadId);
    return host && Object.hasOwn(host.state.items, key) ? host.state.items[key]?.id : undefined;
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
    // A daemon that is down: the socket opens and drops at once, so clients keep retrying.
    if (this.refusing) queueMicrotask(() => connection.close(1006));
    return connection;
  }
  /** Answer these requests with the daemon's `unavailable` error, as a failing service would. */
  failRequests(...types: ClientMessage["type"][]): void {
    for (const type of types) this.faults.set(type, "fail");
  }
  /** Never answer these requests, so the page stays on its loading state. */
  holdRequests(...types: ClientMessage["type"][]): void {
    for (const type of types) this.faults.set(type, "hold");
  }
  /** Serve every request again. */
  restoreRequests(): void {
    this.faults.clear();
  }
  fault(type: ClientMessage["type"]): "fail" | "hold" | undefined {
    return this.faults.get(type);
  }
  /** While on, every connection is dropped as it opens, as a stopped daemon would. */
  refuseConnections(refuse: boolean): void {
    this.refusing = refuse;
    if (refuse) this.disconnectAll();
  }
  /** The scripts a workspace's package.json declares, replacing the catalog's. */
  setScripts(workspaceId: string, names: readonly string[]): void {
    this.servicesWire.workspace.setScripts(workspaceId, names);
  }
  service(message: ClientMessage, connection: Connection): boolean {
    if (message.type === "queue.get") {
      const host = this.threads.get(message.threadId);
      const page =
        host && host.view.thread.deletedAt === undefined
          ? queuePage(host, message.threadId, message)
          : "thread_not_found";
      connection.push(
        typeof page === "string"
          ? { type: "error", code: page, message: page, requestId: message.requestId }
          : { type: "queue.result", requestId: message.requestId, queue: page },
      );
      return true;
    }
    return this.services.handle(message, connection.push);
  }
  release(connection: Connection): void {
    this.connections.delete(connection);
    this.services.release(connection.push);
  }
  /** Drop every socket, as a daemon restart or network loss would. */
  disconnectAll(code = 1006): void {
    // Deleting the current entry during Set iteration is safe.
    for (const connection of this.connections) connection.close(code);
  }
  /** Run the auto-settle and snooze-expiry timers for every thread, as the daemon's do. */
  sweep(): void {
    const at = this.options.clock();
    for (const host of this.threads.values()) this.settle(host, at);
  }
  private settle(host: ThreadHost, at: number): void {
    const changes = settleDecision(
      host.view.thread,
      settlePolicy(this.services.settings.organizationEntries({ threadId: host.view.thread.id })),
      at,
    );
    if (
      Object.entries(changes).some(
        ([key, value]) => (Reflect.get(host.view.thread, key) ?? null) !== value,
      )
    )
      this.append(host, [{ type: "thread.client.updated", changes }], at);
  }
  snapshot(scope: SubscriptionScope): ThreadView | ThreadListView | undefined {
    if (scope.kind === "threads") return { ...structuredClone(this.list), seq: this.seq };
    const host = this.threads.get(scope.threadId);
    return host && host.view.thread.deletedAt === undefined
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
    if (previous)
      return previous.deviceId === command.deviceId
        ? previous.result
        : { commandId: command.id, ok: false, error: "forbidden" };
    let result: CommandResult;
    try {
      result = this.execute(command);
    } catch (error) {
      result = {
        commandId: command.id,
        ok: false,
        error: error instanceof Error ? error.message : "command_failed",
      };
    }
    this.receipts.set(command.id, { deviceId: command.deviceId, result });
    return result;
  }
  private run(
    commandId: Command["id"],
    threadId: string,
    decide: (host: ThreadHost) => ThreadCommandOutcome,
  ): CommandResult {
    const host = this.threads.get(threadId);
    if (!host || host.view.thread.deletedAt !== undefined)
      return { commandId, ok: false, error: "thread_not_found" };
    const outcome = decide(host);
    if (!outcome.ok) return { commandId, ok: false, error: outcome.error };
    this.apply(threadId, outcome.facts);
    return { commandId, ok: true };
  }
  private migrationTarget(host: ThreadHost): string | undefined {
    const thread = host.view.thread;
    const current = thread.live?.account ?? thread.execution?.instanceId;
    const from = this.services.accounts.find((account) => account.id === current);
    return this.services.accounts.find(
      (account) =>
        account.id !== current &&
        account.provider === (from?.provider ?? thread.provider) &&
        account.availability !== "exhausted",
    )?.id;
  }
  private execute(command: Command): CommandResult {
    const payload = command.payload;
    const commandId = command.id;
    const service = this.servicesWire.command(payload);
    if (service) return { commandId, ...service };
    if (
      organizationCommands.some((type) => type === payload.type) &&
      "threadId" in payload &&
      payload.threadId
    ) {
      const host = this.threads.get(payload.threadId);
      if (!host || host.view.thread.deletedAt !== undefined)
        return { commandId, ok: false, error: "thread_not_found" };
      if (
        payload.type === "thread.delete" &&
        (host.queued.length || this.servicesWire.workspace.terminals.hasOwnedWork(host.id))
      )
        return { commandId, ok: false, error: "thread_busy" };
      const decision = organizationDecision(host.view.thread, command, this.options.clock());
      if (typeof decision === "string") return { commandId, ok: false, error: decision };
      this.append(host, [decision], this.options.clock());
      return { commandId, ok: true, threadId: ThreadId.parse(host.id) };
    }
    if (isQueueCommand(payload)) {
      const result = this.run(commandId, payload.threadId, (host) =>
        queueCommand(host, payload, this.options.clock()),
      );
      // Moving a limited thread runs it on the chosen account from now on, or, as the daemon
      // does when none is named, the same provider's account with headroom.
      const host = this.threads.get(payload.threadId);
      if (
        result.ok &&
        host &&
        payload.type === "thread.limit" &&
        payload.action === "migrate_now"
      ) {
        const account = payload.instanceId ?? this.migrationTarget(host);
        if (account)
          this.append(
            host,
            [
              {
                type: "thread.client.updated",
                changes: { live: { ...host.view.thread.live, account } },
              },
            ],
            this.options.clock(),
          );
      }
      return result;
    }
    switch (payload.type) {
      case "thread.fork": {
        const source = this.threads.get(payload.threadId);
        if (!source || source.view.thread.deletedAt !== undefined)
          return { commandId, ok: false, error: "thread_not_found" };
        const refused = forkPointError(source, payload.point);
        if (refused) return { commandId, ok: false, error: refused };
        const id = `${payload.threadId}-fork-${commandId}`;
        if (this.threads.has(id)) return { commandId, ok: true, forkThreadId: ThreadId.parse(id) };
        const from = source.view.thread;
        const provider = payload.selection?.provider ?? from.provider;
        const started = startedThread(id, {
          type: "thread.create",
          workspaceId: from.workspaceId,
          provider,
          ...(payload.selection?.model ? { model: payload.selection.model } : {}),
          title: payload.title ?? `${from.title} (fork)`,
          input: [{ type: "text", text: payload.input }],
        });
        this.createThread({
          ...started.thread,
          ...(from.details ? { details: from.details } : {}),
          lineage: {
            parentThreadId: from.id,
            parentAgentId: AgentId.parse(source.view.thread.rootAgentId ?? `${from.id}.root`),
            point: payload.point,
            mode: provider === from.provider ? "native" : "portable",
            lossy: provider !== from.provider,
          },
        });
        this.apply(id, started.facts);
        return { commandId, ok: true, forkThreadId: ThreadId.parse(id) };
      }
      case "thread.switch": {
        const host = this.threads.get(payload.threadId);
        if (!host || host.view.thread.deletedAt !== undefined)
          return { commandId, ok: false, error: "thread_not_found" };
        const at = this.options.clock();
        this.append(
          host,
          [
            {
              type: "thread.updated",
              switch: {
                selection: { ...payload.selection, options: payload.selection.options ?? {} },
                state: "queued",
                lossy: payload.selection.provider !== host.view.thread.provider,
                at,
              },
            },
          ],
          at,
        );
        this.afterChange(host, at);
        return { commandId, ok: true };
      }
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
        // Never reaches a provider: the new thread reads the request and keeps "working".
        const id = `thread-${commandId}`;
        if (this.threads.has(id)) return { commandId, ok: true, threadId: ThreadId.parse(id) };
        if (payload.context?.draftId)
          this.servicesWire.context.validateDraft(
            command.deviceId,
            payload.context.draftId,
            payload.workspaceId,
            id,
          );
        const started = startedThread(id, payload);
        this.createThread({
          ...started.thread,
          details: {
            workspace: {
              id: payload.workspaceId,
              name: payload.workspaceId,
              path: `/fake/${payload.workspaceId}`,
            },
            mode: payload.mode ?? "local",
            worktree: `/fake/${payload.workspaceId}`,
            branch: payload.baseBranch ?? "main",
            ...(payload.baseBranch ? { baseBranch: payload.baseBranch } : {}),
            machine: { host: "fake-host", name: "Fake machine" },
            diff: { files: 0, additions: 0, deletions: 0 },
          },
          live: {
            ...(payload.model ? { model: payload.model } : {}),
            ...((payload.accountId ?? payload.account)
              ? { account: payload.accountId ?? payload.account }
              : {}),
            ...(payload.options ? { options: payload.options } : {}),
            subagentCount: 0,
            backgroundTaskCount: 0,
          },
        });
        if (payload.context?.draftId)
          this.servicesWire.context.adopt(command.deviceId, payload.context.draftId, id);
        this.apply(id, started.facts);
        return { commandId, ok: true, threadId: ThreadId.parse(id) };
      }
      case "thread.send":
        return this.run(commandId, payload.threadId, (host) =>
          sendFacts(host, commandId, {
            ...payload,
            // An omitted delivery resolves the person's follow-up setting, as the daemon does.
            delivery:
              payload.delivery ??
              (this.services.settings.resolve("threads.followUpBehavior", {
                threadId: payload.threadId,
              }) === "steer"
                ? "steer"
                : "queue"),
          }),
        );
      case "thread.interrupt":
        return this.run(commandId, payload.threadId, (host) =>
          interruptFacts(host, payload.agentId, payload.cascade),
        );
      case "background_task.stop": {
        for (const host of this.threads.values()) {
          const outcome = stopTaskFacts(host, payload.taskId);
          if (outcome) return this.run(commandId, host.id, () => outcome);
        }
        return { commandId, ok: false, error: "task_not_found" };
      }
      case "thread.archive": {
        const host = this.threads.get(payload.threadId);
        if (!host) return { commandId, ok: false, error: "not_found" };
        const now = this.options.clock();
        this.append(host, [{ type: "thread.updated", archivedAt: now }], now);
        return { commandId, ok: true };
      }
      case "review.open":
      case "review.comment":
      case "review.reply":
      case "review.resolve":
      case "review.applySuggestion":
      case "review.sendToAgent":
      case "review.askReviewer":
      case "review.refresh":
      case "review.status":
      case "review.list":
        return { commandId, ...this.review.execute(payload) };
      default:
        return { commandId, ok: false, error: "unsupported_by_fake_daemon" };
    }
  }
}
