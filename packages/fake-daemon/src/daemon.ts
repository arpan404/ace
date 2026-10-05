import { providerConfiguration } from "@ace/models/preferences";
import { ProviderConfigurations } from "@ace/protocol";
import {
  resolvePermissionMode,
  limitPermissionMode,
  permissionAuthority,
  isPermissionOption,
  permissionResolutionError,
} from "@ace/core";
import { PermissionMode } from "@ace/protocol";
import { fakeReviewEvents, fakePermissionCapabilities } from "./permissions.ts";
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
  CommandId,
  DeviceId,
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
import { FakeLongThreadWire } from "./long-thread-wire.ts";
import { FakeOutputStore } from "./output-store.ts";
import type { FakeBrowser } from "./browser.ts";
import type { FakeTerminals } from "./terminals.ts";
import type { FakeProjects } from "./projects.ts";
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
  hostId?: string;
  displayName?: string;
  version?: string;
  catalog?: Partial<Pick<FakeServices, "accounts" | "models" | "commands" | "providerStatuses">>;
  deviceScopes?: Readonly<Record<string, readonly import("@ace/protocol").DeviceScope[]>>;
  projectScheduler?: (callback: () => void) => void;
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
  permissionMode?: PermissionMode;
  parentThreadId?: string;
}
type ResolvedListener = (threadId: string, key: Key, resolution?: InteractionResolution) => void;

/**
 * In-memory daemon speaking the real wire protocol. Scripted adapter facts go through
 * `@ace/core`, so thread and agent status are derived exactly as the daemon derives them.
 */
export class FakeDaemon implements Host {
  readonly hostId: HostId;
  get displayName(): string {
    const name = this.services.settings.get("host.displayName");
    return typeof name === "string" && name ? name : (this.options.displayName ?? "Fake machine");
  }
  readonly version: string;
  /** Fault injection: deliver every event frame twice. */
  duplicateEvents = false;
  private options: FakeDaemonOptions;
  private servicesWire: FakeServicesWire;
  private seq = 0;
  private log: DeliveryEvent[] = [];
  private threads = new Map<string, ThreadHost>();
  private list: ThreadListView = createThreadListView();
  private connections = new Set<Connection>();
  private projectFlights = new Map<string, { device: string; result: Promise<CommandResult> }>();
  private receipts = new Map<string, { deviceId: Command["deviceId"]; result: CommandResult }>();
  private resolvedListeners = new Set<ResolvedListener>();
  private outputs = new FakeOutputStore();
  private longThreads: FakeLongThreadWire;
  private faults = new Map<string, "fail" | "hold">();
  private refusals = new Map<string, string>();
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
    this.hostId = HostId.parse(options.hostId ?? "fake-host");
    this.version = options.version ?? "fake";
    this.longThreads = new FakeLongThreadWire({
      head: () => this.seq,
      thread: (id) => this.threads.get(id),
      now: options.clock,
      output: (id) => {
        const output = this.outputs.read(id, 0, 1024 * 1024);
        return output ? new TextDecoder().decode(output.bytes) : "";
      },
    });
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
    Object.assign(this.services, options.catalog);
    this.servicesWire = new FakeServicesWire(
      {
        now: options.clock,
        canManageProjects: (device) => this.canManageProjects(device),
        scheduleProject:
          options.projectScheduler ??
          ((callback) => {
            setTimeout(callback, 0);
          }),
        createThread: (input) => this.createThread(input),
        apply: (id, facts) => this.apply(id, facts),
        thread: (id) => {
          const host = this.threads.get(id);
          return host?.view.thread.deletedAt === undefined ? host?.view : undefined;
        },
        threads: () => [...this.threads.values()].map((host) => host.view.thread),
        update: (id, payload) => this.append(this.thread(id), [payload], options.clock()),
        onResolved: (listener) => this.onResolved(listener),
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
  /** The host folders and project catalog behind `projects.request` and project commands. */
  get projects(): FakeProjects {
    return this.servicesWire.workspace.projects;
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
  private permissionAuthority(id: string): PermissionMode {
    return permissionAuthority(id, (key) => {
      const host = this.threads.get(key);
      return host
        ? {
            effective: host.view.thread.permission?.effective ?? "auto-review",
            parent: host.permissionParent ?? null,
          }
        : undefined;
    });
  }
  createThread(init: ThreadInit, agoMs = 0): void {
    if (this.threads.has(init.id)) throw new Error(`Thread ${init.id} already exists`);
    const now = this.at(agoMs);
    const parentId = init.parentThreadId ?? init.lineage?.parentThreadId;
    const parent = parentId ? this.permissionAuthority(parentId) : undefined;
    const thread = {
      id: ThreadId.parse(init.id),
      workspaceId: WorkspaceId.parse(init.workspaceId),
      title: init.title,
      provider: init.provider,
      capabilities: structuredClone(fakePermissionCapabilities),
      ...(init.details ? { details: init.details } : {}),
      ...(init.live ? { live: init.live } : {}),
      ...(init.lineage ? { lineage: init.lineage } : {}),
      permission: {
        override: init.permissionMode ?? null,
        effective: resolvePermissionMode({
          ...(init.permissionMode ? { override: init.permissionMode } : {}),
          setting:
            parent ??
            PermissionMode.parse(
              this.services.settings.resolve("permissions.defaultMode", {
                workspaceId: WorkspaceId.parse(init.workspaceId),
                threadId: ThreadId.parse(init.id),
              }),
            ),
          ...(parent ? { parent } : {}),
        }),
        pending: false,
      },
      activityAt: now,
      status: { state: "new" as const },
      createdAt: now,
      updatedAt: now,
    };
    const host = new ThreadHost(thread);
    host.permissionParent = parentId;
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
    const fold = (fact: Fact): EventPayload[] => {
      const before: EventPayload[] = [];
      if (
        fact.type === "turn.started" &&
        fact.agent === (host.state.rootKey ?? "root") &&
        ["new", "done", "failed", "limited"].includes(host.state.status.state)
      ) {
        const parent = host.permissionParent
          ? this.permissionAuthority(host.permissionParent)
          : undefined;
        const mode = resolvePermissionMode({
          override: host.view.thread.permission?.override ?? null,
          setting:
            parent ??
            PermissionMode.parse(
              this.services.settings.resolve("permissions.defaultMode", {
                threadId: ThreadId.parse(host.id),
              }),
            ),
          ...(parent ? { parent } : {}),
        });
        const permission = {
          override: host.view.thread.permission?.override ?? null,
          effective: mode,
          pending: false,
        };
        host.view.thread.permission = permission;
        before.push({ type: "thread.updated", permission });
      }
      const emitted = host.fold(fact, now);
      return [...before, ...emitted, ...fakeReviewEvents(host, emitted, now)];
    };
    const payloads = facts.flatMap(fold);
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
    const events = [...selectionEvent, ...payloads, ...drained.flatMap(fold)];
    this.append(host, events, now);
    const reviewed = new Set(
      events.flatMap((event) =>
        event.type === "permission.reviewed" && event.review.decision !== "escalate"
          ? [event.review.interactionId]
          : [],
      ),
    );
    for (const event of events) {
      if (event.type !== "interaction.closed" || event.state !== "resolved" || !event.resolution)
        continue;
      const key = host.interactionKey(event.interactionId);
      if (key !== undefined && reviewed.has(event.interactionId))
        for (const listener of this.resolvedListeners) listener(host.id, key, event.resolution);
    }
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
      this.longThreads.index.record(event, host.view);

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
  /**
   * Seeds where a device last read a thread: through the item an adapter key became, as if it
   * had followed the thread that far (the catch-up card in dev:fake and the screens).
   */
  markReadThrough(threadId: string, key: Key, deviceId: string): void {
    const host = this.thread(threadId);
    const itemId = this.itemId(threadId, key);
    const seq = itemId === undefined ? undefined : host.creation.get(itemId);
    const item = itemId === undefined ? undefined : host.view.items[itemId];
    if (seq === undefined || !item) throw new Error(`No item ${key} in ${threadId}`);
    // Read when that item arrived, as a reader following the thread would have.
    this.longThreads.markRead(
      CommandId.parse(`seed-read-${threadId}`),
      { type: "thread.markRead", threadId: ThreadId.parse(threadId), lastSeenSeq: seq },
      DeviceId.parse(deviceId),
      item.createdAt,
    );
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
  /**
   * The conductor couldn't run a deck's next step (`executionError`), as after a restart that
   * lost its project: the deck reports it until it is resumed.
   */
  failDeck(runId: string, code: string): void {
    this.servicesWire.failDeck(runId, code);
  }
  /** Refuse every command of these types with `error`, as a daemon that won't run them would. */
  refuseCommands(error: string, ...types: Command["payload"]["type"][]): void {
    for (const type of types) this.refusals.set(type, error);
  }
  /** Serve every request and accept every command again. */
  restoreRequests(): void {
    this.faults.clear();
    this.refusals.clear();
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
    if (this.longThreads.handle(message, connection.deviceId, connection.push)) return true;
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
  private canManageProjects(device: string): boolean {
    const scopes = this.options.deviceScopes?.[device];
    return (
      this.options.deviceScopes === undefined ||
      scopes?.includes("projects") === true ||
      scopes?.includes("desktop") === true
    );
  }
  commandAsync(command: Command): Promise<CommandResult> {
    if (!this.canManageProjects(command.deviceId))
      return Promise.resolve({ commandId: command.id, ok: false, error: "forbidden" });
    if (command.payload.type !== "workspace.clone") return Promise.resolve(this.command(command));
    const prior = this.receipts.get(command.id);
    if (prior)
      return Promise.resolve(
        prior.deviceId === command.deviceId
          ? prior.result
          : { commandId: command.id, ok: false, error: "forbidden" },
      );
    const pending = this.projectFlights.get(command.id);
    if (pending)
      return pending.device === command.deviceId
        ? pending.result
        : Promise.resolve({ commandId: command.id, ok: false, error: "forbidden" });
    const result = this.servicesWire.workspace.projects
      .clone(command.payload, command.id, command.deviceId)
      .then((outcome) => {
        const receipt = { commandId: command.id, ...outcome };
        this.receipts.set(command.id, { deviceId: command.deviceId, result: receipt });
        this.projectFlights.delete(command.id);
        return receipt;
      });
    this.projectFlights.set(command.id, { device: command.deviceId, result });
    return result;
  }
  command(command: Command): CommandResult {
    const previous = this.receipts.get(command.id);
    if (previous)
      return previous.deviceId === command.deviceId
        ? previous.result
        : { commandId: command.id, ok: false, error: "forbidden" };
    const payload = command.payload;
    if (
      [
        "thread.create",
        "thread.prepare",
        "thread.send",
        "thread.fork",
        "thread.switch",
        "thread.resume",
        "queue.resume",
        "thread.merge",
        "thread.model.set",
        "thread.mode.set",
      ].includes(payload.type)
    ) {
      const thread =
        "threadId" in payload && payload.threadId
          ? this.threads.get(payload.threadId)?.view.thread
          : undefined;
      const provider =
        "provider" in payload
          ? payload.provider
          : "selection" in payload && payload.selection
            ? payload.selection.provider
            : thread?.provider;
      const configurations = ProviderConfigurations.parse(
        this.services.settings.get("providers.configuration"),
      );
      const instance =
        ("instanceId" in payload ? payload.instanceId : undefined) ??
        ("accountId" in payload ? payload.accountId : undefined) ??
        ("account" in payload ? payload.account : undefined) ??
        ("selection" in payload && payload.selection ? payload.selection.instanceId : undefined) ??
        thread?.instanceId;
      if (provider && providerConfiguration(configurations, provider, instance).enabled === false)
        return { commandId: command.id, ok: false, error: "provider_disabled" };
    }
    const refusal = this.refusals.get(command.payload.type);
    if (refusal) return { commandId: command.id, ok: false, error: refusal };
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
    if (
      [
        "workspace.add",
        "workspace.create",
        "workspace.clone",
        "workspace.rename",
        "workspace.remove",
      ].includes(payload.type) &&
      !this.canManageProjects(command.deviceId)
    )
      return { commandId: command.id, ok: false, error: "forbidden" };
    if (
      (payload.type === "thread.create" || payload.type === "thread.prepare") &&
      this.servicesWire.workspace.projects.isRemoved(payload.workspaceId)
    )
      return { commandId: command.id, ok: false, error: "workspace_unregistered" };
    const commandId = command.id;
    const options =
      "selection" in payload && payload.selection
        ? payload.selection.options
        : "options" in payload
          ? payload.options
          : undefined;
    if (Object.keys(options ?? {}).some(isPermissionOption))
      return { commandId, ok: false, error: "provider_permission_options_forbidden" };
    const service = this.servicesWire.command(payload, commandId);
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
      case "thread.markRead":
        return this.longThreads.markRead(commandId, payload, command.deviceId);
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
          const pending = host.interaction(key);
          if (!pending) return { commandId, ok: false, error: "not_found" };
          const browserOriginApproval = pending.raw.some(
            (raw) => raw.type === "ace.browser.origin",
          );
          if (
            browserOriginApproval &&
            (payload.resolution.kind !== "approval" ||
              !["allow_once", "allow_thread", "deny"].includes(payload.resolution.optionId))
          )
            return { commandId, ok: false, error: "invalid_resolution" };
          const error = browserOriginApproval
            ? undefined
            : permissionResolutionError(
                host.view.thread.permission?.effective ?? "auto-review",
                pending.request,
                payload.resolution,
              );
          if (error) return { commandId, ok: false, error };
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
      case "thread.permission.set": {
        const host = this.threads.get(payload.threadId);
        if (!host) return { commandId, ok: false, error: "thread_not_found" };
        const parent = host.permissionParent
          ? this.permissionAuthority(host.permissionParent)
          : undefined;
        if (
          payload.permissionMode &&
          limitPermissionMode(payload.permissionMode, parent) !== payload.permissionMode
        )
          return { commandId, ok: false, error: "permission_exceeds_parent" };
        this.append(
          host,
          [
            {
              type: "thread.updated",
              permission: {
                override: payload.permissionMode,
                effective: host.view.thread.permission?.effective ?? "auto-review",
                pending: true,
              },
            },
          ],
          this.options.clock(),
        );
        return { commandId, ok: true };
      }
      case "thread.prepare": {
        if (this.threads.has(payload.threadId))
          return { commandId, ok: false, error: "thread_exists" };
        this.createThread({
          id: payload.threadId,
          workspaceId: payload.workspaceId,
          title: payload.title,
          provider: payload.provider,
          ...(payload.permissionMode ? { permissionMode: payload.permissionMode } : {}),
          details: {
            mode: payload.mode ?? "local",
            worktree:
              payload.mode === "worktree"
                ? `/fake/worktrees/${payload.threadId}`
                : `/fake/${payload.workspaceId}`,
            branch: payload.baseBranch ?? "main",
            ...(payload.baseBranch ? { baseBranch: payload.baseBranch } : {}),
          },
        });
        return { commandId, ok: true, threadId: payload.threadId };
      }
      case "thread.create": {
        // Never reaches a provider: the new thread reads the request and keeps "working".
        const id = payload.threadId ?? `thread-${commandId}`;
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
          ...(payload.permissionMode ? { permissionMode: payload.permissionMode } : {}),
          details: {
            workspace: {
              id: payload.workspaceId,
              name: payload.workspaceId,
              path: `/fake/${payload.workspaceId}`,
            },
            mode: payload.mode ?? "local",
            worktree:
              payload.mode === "worktree"
                ? `/fake/worktrees/${id}`
                : `/fake/${payload.workspaceId}`,
            branch: payload.baseBranch ?? "main",
            ...(payload.baseBranch ? { baseBranch: payload.baseBranch } : {}),
            machine: { host: this.hostId, name: this.displayName },
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
