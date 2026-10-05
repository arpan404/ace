import {
  pendingSend,
  matchesPendingThread,
  pendingSendsEqual,
  type PendingSend,
} from "./pending-sends.ts";
import { projectCalls } from "./project-calls.ts";
import { projectEvents } from "./projects.ts";
import type { ProjectsApi } from "./projects-types.ts";
import type {
  TurnsPageInput,
  ItemsWindowInput,
  ThreadSearchInput,
  ThreadCatchUpInput,
  ThreadReadStateInput,
  ThreadMarkReadInput,
} from "./long-thread.ts";
import { ReadMarkers } from "./read-markers.ts";
import type { FileDownloadInput, FileUploadInput } from "./files-types.ts";
import type { HistoryScanStatus, HistoryListRequest } from "@ace/protocol/history";
import type { ServiceRequest, ServiceResponse } from "./service-requests.ts";
import { decodeUtf16 } from "./utf16.ts";
import { decodeBase64 } from "./base64.ts";
import {
  type Item,
  ThreadId,
  CommandId,
  ThreadMarkReadCommand,
  CoreClientMessage,
  CoreServerMessage,
  TextSource,
  CommandResult,
  ItemsPage,
  type CursorAuthEvent,
  type CursorAuthRequest,
  type RegistryResult,
  type ServerMessage,
  type CommandPayload,
  type SettingsKey,
  type SettingsScope,
  type SettingsLayer,
} from "@ace/protocol";
import type { ClientApi, ConnectionControl, RegistryQuery } from "./api.ts";
import { Connection, sameConnectionInfo } from "./connection.ts";
import { WireCodec, type ServiceWire } from "./wire-codec.ts";
import { isOneWayMessage, type OneWayMessage } from "./one-way.ts";
import { Intents, type Intent } from "./intents.ts";
import { Notifications, type Selection } from "./observable.ts";
import { Requests } from "./requests.ts";
import { Sidebar } from "./sidebar.ts";
import { Subscriptions, type ThreadSubscription } from "./subscriptions.ts";
import { retryDelay } from "./lifecycle.ts";
import {
  ClientError,
  defaultLimits,
  type ClientOptions,
  type RequestOptions,
  type ConnectionInfo,
  type ConnectionState,
} from "./types.ts";

export type { RegistryQuery } from "./api.ts";
type WithoutRequestId<T> = T extends unknown ? Omit<T, "requestId"> : never;
export type CursorAuthQuery = WithoutRequestId<CursorAuthRequest>;

export class Client implements ClientApi, ConnectionControl {
  /** Project calls forward through `command`/`request`; pushes arrive through `onMessage`. */
  readonly projects: ProjectsApi = { ...projectCalls(this), ...projectEvents(this) };
  private options: ClientOptions;
  private connection: Connection;
  /** Core frames decode at once; the service schemas load with `start()`. */
  private codec = new WireCodec();
  private requests: Requests;
  private subscriptions: Subscriptions;
  private sidebar: Sidebar;
  private intents: Intents;
  private notifications: Notifications;
  private historyState: HistoryScanStatus | undefined;
  private closed = false;
  private readMarkers: ReadMarkers;
  private serviceListeners = new Set<(message: ServerMessage) => void>();
  private hostId: string | undefined;
  private pendingSendEntries = new Map<string, PendingSend>();
  private waitingHints = new Map<string, () => void>();
  constructor(options: ClientOptions) {
    this.options = options;
    const limits = { ...defaultLimits, ...options.limits };
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value <= 0) throw new ClientError("limit");
    if (limits.threads > 63)
      throw new ClientError("limit", "Reserve one of 64 subscriptions for the sidebar");
    this.notifications = new Notifications(limits.listeners);
    this.requests = new Requests(options.scheduler, limits.requests, limits.requestMs);
    this.readMarkers = new ReadMarkers(
      options.scheduler,
      limits.requests,
      limits.requestMs,
      (input) => this.readMark(input),
    );
    this.connection = new Connection(
      options,
      this.codec,
      limits,
      (message) => {
        for (const listener of this.serviceListeners) {
          try {
            listener(message);
          } catch {
            // A consumer cannot break protocol delivery.
          }
        }
        if (
          "requestId" in message &&
          message.type !== "error" &&
          message.type !== "history.operation.progress" &&
          message.requestId
        )
          this.requests.resolve(message.requestId, message);
        switch (message.type) {
          case "welcome":
            if (this.hostId && this.hostId !== message.hostId)
              throw new ClientError("protocol", "Transport changed daemon identity");
            this.hostId = message.hostId;
            this.historyState = undefined;
            this.notifications.emit(["historyScan"]);
            this.subscriptions.reconnect();
            this.sidebar.reconnect();
            this.intents.replay();
            this.readMarkers.reconnect();
            break;
          case "commandResult":
            this.requests.resolve(message.commandId, message);
            void this.intents
              .acknowledge(message)
              .catch(() => this.connection.fail(new ClientError("storage")));
            break;
          case "history.scan.updated":
            this.historyState = message.scan;
            this.notifications.emit(["historyScan"]);
            break;
          case "history.scan":
          case "history.list":
            if (message.scan) {
              this.historyState = message.scan;
              this.notifications.emit(["historyScan"]);
            }
            // The reply itself was resolved above with every other correlated reply.
            break;
          case "queue.result":
          case "settings.result":
          case "cursor.auth.login":
          case "cursor.auth.changed":
          case "cursor.auth.error":
          case "registry.result":
          case "output.data":
            // Resolved above with every other correlated reply.
            break;
          case "error":
            if (message.requestId)
              this.requests.reject(message.requestId, new ClientError("daemon", message.code));
            else if (message.subscriptionId) {
              const error = new ClientError("daemon", message.code);
              this.subscriptions.reject(message.subscriptionId, error);
              this.sidebar.reject(message.subscriptionId, error);
            } else if (message.commandId) {
              // A refused command settles its own intent; the connection stays usable.
              if (!message.retryable)
                this.requests.reject(message.commandId, new ClientError("daemon", message.code));
              void this.intents
                .refuse(message.commandId, message.code, message.retryable === true)
                .catch(() => this.connection.fail(new ClientError("storage")));
            } else this.connection.fail(new ClientError("daemon", message.code));
            break;
          default:
            this.subscriptions.receive(message);
            this.sidebar.receive(message);
            this.observeInputs(message);
        }
      },
      () => this.notifications.emit(["connection"]),
      () => {
        this.readMarkers.disconnect();
        this.requests.disconnect();
        this.subscriptions.disconnect();
        this.intents.disconnect();
        this.sidebar.disconnect();
      },
    );
    this.subscriptions = new Subscriptions(
      limits,
      (message) => this.connection.send(message),
      options.id,
      () => this.state === "ready",
    );
    this.sidebar = new Sidebar(
      limits,
      (message) => this.connection.send(message),
      options.id,
      () => this.state === "ready",
    );
    this.intents = new Intents({
      storage: options.storage,
      device: options.deviceId,
      limit: limits.intents,
      bytes: limits.outboxBytes,
      frameBytes: limits.sendBytes,
      changed: (id) => {
        const intent = this.intents.get(id);
        if (intent?.state === "pending" && !this.waitingHints.has(id))
          this.waitingHints.set(
            id,
            options.scheduler.set(5_000, () => this.intents.waiting(id)),
          );
        else if (intent?.state !== "pending") {
          this.waitingHints.get(id)?.();
          this.waitingHints.delete(id);
        }
        if (intent?.state === "failed" && !intent.localFailure)
          this.requests.resolve(id, { commandId: id, ok: false, error: intent.error });
        const hadEntry = this.pendingSendEntries.has(id);
        const entry = intent && pendingSend(intent);
        if (entry) this.pendingSendEntries.set(id, entry);
        else this.pendingSendEntries.delete(id);
        this.notifications.emit([
          `intent:${id}`,
          ...(entry || hadEntry ? [`pendingSend:${id}`, "pendingSends"] : []),
        ]);
      },
      send: (command) => {
        if (this.state === "ready") this.connection.send({ type: "command", command });
      },
      retryAfter: (attempt, run) =>
        options.scheduler.set(
          retryDelay(attempt, limits.retryBaseMs, limits.retryCapMs, options.random()),
          run,
        ),
    });
  }
  private observeInputs(message: ServerMessage): void {
    const observe = (item: Item) => {
      if (item.type === "notice" && item.commandId && item.level === "error") {
        void this.intents
          .deliveryFailed(item.commandId, item.detail ?? item.text)
          .catch(() => this.connection.fail(new ClientError("storage")));
        return;
      }
      if (item.type !== "message" || item.role !== "user") return;
      const id =
        item.origin?.commandId ?? (item.id.startsWith("input:") ? item.id.slice(6) : undefined);
      if (id)
        void this.intents.observe(id).catch(() => this.connection.fail(new ClientError("storage")));
    };
    if (message.type === "snapshot" && message.view.kind === "thread")
      for (const item of Object.values(message.view.items)) observe(item);
    else if (message.type === "items.page" || message.type === "items.window")
      for (const item of message.items) observe(item);
    else if (message.type === "events")
      for (const event of message.events) {
        if (event.payload.type === "item.created" || event.payload.type === "item.updated")
          observe(event.payload.item);
      }
  }
  get state(): ConnectionState {
    return this.connection.state;
  }
  get error(): ClientError | undefined {
    return this.connection.error;
  }
  connectionState(): Selection<ConnectionState> {
    return this.notifications.select(["connection"], () => this.state);
  }
  connectionInfo(): Selection<ConnectionInfo> {
    return this.notifications.select(
      ["connection"],
      () => this.connection.info(),
      sameConnectionInfo,
    );
  }
  reconnectNow(): void {
    this.connection.reconnectNow();
  }
  /** Worker-owned allocation also supplies tab prefixes; no tab reaches for randomness. */
  commandId(): string {
    return CommandId.parse(this.options.id());
  }
  pendingSend(id: string): PendingSend | undefined {
    return this.pendingSendEntries.get(id);
  }
  observePendingSends(listener: (id: string) => void): () => void {
    return this.notifications.tap((keys) => {
      if (keys === "all") return;
      for (const key of keys) if (key.startsWith("pendingSend:")) listener(key.slice(12));
    });
  }
  intent(id: string): Selection<Intent | undefined> {
    return this.notifications.select([`intent:${id}`], () => this.intents.get(id));
  }
  pendingSends(threadId?: string): Selection<readonly PendingSend[]> {
    return this.notifications.select(
      ["pendingSends"],
      () =>
        [...this.pendingSendEntries.values()].filter((entry) =>
          matchesPendingThread(entry, threadId),
        ),
      pendingSendsEqual,
    );
  }

  async start(): Promise<void> {
    // Usually loaded before the socket's welcome; a service frame that beats it waits for it.
    void this.codec.load().catch(() => {});
    try {
      await this.intents.initialize();
      if (!this.closed) this.connection.start();
    } catch {
      this.connection.fail(new ClientError("storage"));
      throw new ClientError("storage");
    }
  }
  close(): Promise<void> {
    this.closed = true;
    this.requests.clear(new ClientError("offline"));
    this.readMarkers.close();
    for (const cancel of this.waitingHints.values()) cancel();
    this.waitingHints.clear();
    this.serviceListeners.clear();
    this.connection.stop();
    return this.intents.settled();
  }
  networkOnline(online: boolean): void {
    this.connection.networkOnline(online);
  }
  thread(id: string): ThreadSubscription {
    if (this.closed) throw new ClientError("offline");
    return this.subscriptions.acquire(id);
  }
  threads(): { store: Sidebar; release(): void } {
    if (this.closed) throw new ClientError("offline");
    return this.sidebar.acquire();
  }
  async enqueue(payload: CommandPayload, id = this.options.id()): Promise<string> {
    if (this.closed) throw new ClientError("offline");
    await this.intents.enqueue(id, payload);
    return id;
  }
  /** Read cursors are last-write-wins hints, never durable outbox payloads. */
  private readMark(input: ThreadMarkReadInput): Promise<CommandResult> {
    if (this.state !== "ready" || this.closed) return Promise.reject(new ClientError("offline"));
    const id = this.options.id();
    return this.requests.wait(id, CommandResult.parse, {}, () => {
      this.connection.send({
        type: "command",
        command: {
          id: CommandId.parse(id),
          deviceId: this.options.deviceId,
          payload: ThreadMarkReadCommand.parse({ type: "thread.markRead", ...input }),
        },
      });
    });
  }
  command(
    payload: CommandPayload,
    options: RequestOptions = {},
    id = this.options.id(),
  ): Promise<CommandResult> {
    if (payload.type === "thread.markRead")
      return this.markThreadRead(
        {
          threadId: payload.threadId,
          lastSeenSeq: payload.lastSeenSeq,
        },
        options,
      );
    if (payload.type === "diagnostics.health")
      return this.request({ type: "diagnostics.health" }, options).then(({ ok, health, error }) =>
        CommandResult.parse({
          commandId: id,
          ok,
          ...(health ? { health } : {}),
          ...(error ? { error } : {}),
        }),
      );
    if (this.closed) return Promise.reject(new ClientError("offline"));
    return this.requests.waitDurable(id, CommandResult.parse, options, () => {
      void this.enqueue(payload, id).catch((error: unknown) =>
        this.requests.reject(
          id,
          error instanceof ClientError ? error : new ClientError("protocol"),
        ),
      );
    });
  }
  /** One-off service operation. Never persisted or replayed after a disconnect. */
  request<Q extends ServiceRequest>(
    input: Q,
    options: RequestOptions = {},
  ): Promise<ServiceResponse<Q>> {
    if (this.state !== "ready" || this.closed) return Promise.reject(new ClientError("offline"));
    const id = options.requestId ?? this.options.id();
    return this.service().then((wire) => this.sendRequest(wire, input, id, options));
  }
  private sendRequest<Q extends ServiceRequest>(
    wire: ServiceWire,
    input: Q,
    id: string,
    options: RequestOptions,
  ): Promise<ServiceResponse<Q>> {
    const parsed = wire.ClientMessage.safeParse({ ...input, requestId: id });
    if (!parsed.success) return Promise.reject(new ClientError("protocol", "Invalid request"));
    let sent = false;
    return this.requests
      .wait(
        id,
        (value) => wire.decodeServiceResponse(wire.ServerMessage, input, id, value),
        options,
        () => {
          sent = this.connection.send(parsed.data);
          if (!sent) throw new ClientError("offline");
        },
      )
      .catch((error: unknown) => {
        if (sent && parsed.data.type === "files.request")
          this.connection.send({ type: "files.abort", sourceRequestId: id });
        throw error;
      });
  }
  /** Uncorrelated service messages (such as `settings.changed`); the caller releases it. */
  onMessage(listener: (message: ServerMessage) => void): () => void {
    if (this.closed) throw new ClientError("offline");
    if (this.serviceListeners.size >= (this.options.limits?.listeners ?? defaultLimits.listeners))
      throw new ClientError("limit");
    this.serviceListeners.add(listener);
    return () => {
      this.serviceListeners.delete(listener);
    };
  }
  /** One-way service controls, such as browser frame ACKs or terminal credits. */
  send(message: OneWayMessage): void {
    const control = this.decodeOneWay(message);
    if (control === null) throw new ClientError("protocol", "Invalid one-way message");
    if (this.state !== "ready" || this.closed || !control || !this.connection.send(control))
      throw new ClientError("offline");
  }
  /**
   * A one-way control checked against the full schema: null when it is not one, undefined
   * while the service schemas are still loading (it is then dropped, as offline).
   */
  decodeOneWay(value: unknown): OneWayMessage | null | undefined {
    const wire = this.codec.loaded;
    if (!wire) return undefined;
    const parsed = wire.ClientMessage.safeParse(value);
    return parsed.success && isOneWayMessage(parsed.data) ? parsed.data : null;
  }
  /** The service schemas, once they have loaded; offline if the client stopped meanwhile. */
  private async service(): Promise<ServiceWire> {
    const wire = await this.codec.load();
    if (this.state !== "ready" || this.closed) throw new ClientError("offline");
    return wire;
  }
  async registry(input: RegistryQuery, options: RequestOptions = {}): Promise<RegistryResult> {
    if (this.state !== "ready" || this.closed) return Promise.reject(new ClientError("offline"));
    const requestId = this.options.id();
    const wire = await this.service();
    const request = wire.RegistryRequest.parse({ ...input, requestId });
    return this.requests.wait(
      request.requestId,
      (value) => {
        const response = wire.RegistryResult.parse(value);
        if (response.requestId !== request.requestId) throw new ClientError("protocol");
        return response;
      },
      options,
      () => {
        if (!this.connection.send(request)) throw new ClientError("offline");
      },
    );
  }
  /** Ephemeral auth requests never enter the persistent intent outbox. */
  async cursorAuth(input: CursorAuthQuery, options: RequestOptions = {}): Promise<CursorAuthEvent> {
    if (this.state !== "ready" || this.closed) return Promise.reject(new ClientError("offline"));
    const requestId = this.options.id();
    const wire = await this.service();
    const request = wire.CursorAuthRequest.parse({ ...input, requestId });
    return this.requests.wait(
      request.requestId,
      (value) => {
        const event = wire.CursorAuthEvent.parse(value);
        if (event.requestId !== request.requestId) throw new ClientError("protocol");
        return event;
      },
      options,
      () => {
        if (!this.connection.send(request)) throw new ClientError("offline");
      },
    );
  }
  historyScan(): Selection<HistoryScanStatus | undefined> {
    return this.notifications.select(["historyScan"], () => this.historyState);
  }
  scanHistory(options: RequestOptions = {}) {
    return this.historyRequest(
      { type: "history.scan", action: "start" },
      (wire) => wire.HistoryScanResponse.parse,
      options,
    );
  }
  historyScanStatus(options: RequestOptions = {}) {
    return this.historyRequest(
      { type: "history.scan", action: "status" },
      (wire) => wire.HistoryScanResponse.parse,
      options,
    );
  }
  listHistory(
    input: Omit<import("zod").input<typeof HistoryListRequest>, "type" | "requestId">,
    options: RequestOptions = {},
  ) {
    return this.historyRequest(
      { type: "history.list", ...input },
      (wire) => wire.HistoryListResponse.parse,
      options,
    );
  }
  private async historyRequest<T>(
    input:
      | import("zod").input<typeof HistoryListRequest>
      | { type: "history.scan"; action: "start" | "status" },
    decoder: (wire: ServiceWire) => (value: unknown) => T,
    options: RequestOptions,
  ): Promise<T> {
    if (this.state !== "ready" || this.closed) return Promise.reject(new ClientError("offline"));
    const requestId = this.options.id();
    const wire = await this.service();
    const request = wire.ClientMessage.parse({ ...input, requestId });
    return this.requests.wait(requestId, decoder(wire), options, () => {
      if (!this.connection.send(request)) throw new ClientError("offline");
    });
  }
  private async read<T>(
    payload:
      | {
          type: "queue.get";
          threadId: string;
          after?: string;
          expectedRevision?: number;
          limit?: number;
        }
      | { type: "settings.get"; key: SettingsKey; scope: SettingsScope }
      | { type: "settings.set"; key: string; value: unknown; layer: SettingsLayer },
    decoder: (wire: ServiceWire) => (value: unknown) => T,
    options: RequestOptions,
  ): Promise<T> {
    if (this.state !== "ready" || this.closed) throw new ClientError("offline");
    const id = this.options.id();
    const wire = await this.service();
    const decode = decoder(wire);
    const parsed = wire.ClientMessage.safeParse({ ...payload, requestId: id });
    if (!parsed.success) throw new ClientError("protocol", "Invalid read parameters");
    return this.requests.wait(id, decode, options, () => {
      if (!this.connection.send(parsed.data)) throw new ClientError("offline");
    });
  }
  /** A read of the core stream (item pages, output): no service schemas to wait for. */
  private async readCore<T>(
    payload:
      | { type: "items.page"; threadId: string; before: number; limit: number }
      | { type: "output.read"; streamId: string; offset: number; limit: number },
    decode: (value: unknown) => T,
    options: RequestOptions,
  ): Promise<T> {
    if (this.state !== "ready" || this.closed) throw new ClientError("offline");
    const id = this.options.id();
    const parsed = CoreClientMessage.safeParse({ ...payload, requestId: id });
    if (!parsed.success) throw new ClientError("protocol", "Invalid read parameters");
    return this.requests.wait(id, decode, options, () => {
      if (!this.connection.send(parsed.data)) throw new ClientError("offline");
    });
  }
  queue(threadId: string, options: RequestOptions = {}) {
    return this.queuePage({ threadId }, options);
  }
  settingsGet(key: SettingsKey, scope: SettingsScope = {}, options: RequestOptions = {}) {
    return this.read(
      { type: "settings.get", key, scope },
      (wire) => wire.SettingsResult.parse,
      options,
    );
  }
  settingsSet(key: string, value: unknown, layer: SettingsLayer, options: RequestOptions = {}) {
    return this.read(
      { type: "settings.set", key, value, layer },
      (wire) => wire.SettingsResult.parse,
      options,
    );
  }
  queuePage(
    payload: { threadId: string; after?: string; expectedRevision?: number; limit?: number },
    options: RequestOptions = {},
  ) {
    return this.read(
      { type: "queue.get", ...payload },
      (wire) => (value) => wire.QueueResult.parse(value).queue,
      options,
    );
  }
  // Transfers load on first use: the client worker starts without them (ADR 0056).
  async *downloadFile(
    input: FileDownloadInput,
    options: RequestOptions = {},
  ): AsyncGenerator<Uint8Array> {
    const { downloadFile } = await import("./files.ts");
    yield* downloadFile(this, input, options);
  }
  async uploadFile(
    input: FileUploadInput,
    source: AsyncIterable<Uint8Array>,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const { uploadFile } = await import("./files.ts");
    return uploadFile(this, input, source, options);
  }
  async turnsPage(input: TurnsPageInput, options: RequestOptions = {}) {
    const response = await this.request(
      { type: "turns.page", ...input, threadId: decodeThreadId(input.threadId) },
      options,
    );
    if (response.threadId !== input.threadId)
      throw new ClientError("protocol", "Unexpected thread reply");
    return response;
  }
  async itemsWindow(input: ItemsWindowInput, options: RequestOptions = {}) {
    const response = await this.request(
      { type: "items.window", ...input, threadId: decodeThreadId(input.threadId) },
      options,
    );
    if (response.threadId !== input.threadId)
      throw new ClientError("protocol", "Unexpected thread reply");
    return response;
  }
  async threadSearch(input: ThreadSearchInput, options: RequestOptions = {}) {
    const response = await this.request(
      { type: "thread.search", ...input, threadId: decodeThreadId(input.threadId) },
      options,
    );
    if (response.threadId !== input.threadId)
      throw new ClientError("protocol", "Unexpected thread reply");
    return response;
  }
  async threadCatchUp(input: ThreadCatchUpInput, options: RequestOptions = {}) {
    const response = await this.request(
      { type: "thread.catchUp", ...input, threadId: decodeThreadId(input.threadId) },
      options,
    );
    if (response.threadId !== input.threadId)
      throw new ClientError("protocol", "Unexpected thread reply");
    return response;
  }
  async threadReadState(input: ThreadReadStateInput, options: RequestOptions = {}) {
    const response = await this.request(
      { type: "thread.readState", ...input, threadId: decodeThreadId(input.threadId) },
      options,
    );
    if (response.threadId !== input.threadId)
      throw new ClientError("protocol", "Unexpected thread reply");
    return response;
  }
  markThreadRead(input: ThreadMarkReadInput, options: RequestOptions = {}) {
    if (this.state !== "ready" || this.closed) return Promise.reject(new ClientError("offline"));
    const parsed = ThreadMarkReadCommand.safeParse({ type: "thread.markRead", ...input });
    if (!parsed.success) return Promise.reject(new ClientError("protocol", "Invalid read mark"));
    return this.readMarkers.mark(parsed.data, options);
  }
  itemsPage(
    payload: { threadId: string; before?: number | undefined; limit: number },
    options: RequestOptions = {},
  ) {
    return this.readCore(
      { type: "items.page", ...payload, before: payload.before ?? Number.MAX_SAFE_INTEGER },
      (value) => {
        const page = ItemsPage.parse(value);
        if (page.threadId !== payload.threadId) throw new ClientError("protocol");
        return page;
      },
      options,
    );
  }
  async loadOlder(threadId: string, limit: number, options: RequestOptions = {}): Promise<void> {
    const store = this.subscriptions.held(threadId);
    if (!store) throw new ClientError("offline", "Thread is not leased");
    const before = store.itemsBefore;
    if (before === null || before === undefined) return;
    store.page(await this.itemsPage({ threadId, before, limit }, options));
  }
  outputRead(
    payload: { streamId: string; offset: number; limit: number },
    options: RequestOptions = {},
  ) {
    return this.readCore(
      { type: "output.read", ...payload },
      (value) => {
        const result = CoreServerMessage.parse(value);
        if (
          result.type !== "output.data" ||
          result.streamId !== payload.streamId ||
          result.offset !== payload.offset
        )
          throw new ClientError("protocol");
        const bytes = decodeBase64(result.bytes, payload.limit);
        if (
          bytes.length > payload.limit ||
          result.nextOffset !== payload.offset + bytes.length ||
          (!result.eof && !bytes.length)
        )
          throw new ClientError("protocol");
        return { ...result, bytes };
      },
      options,
    );
  }
  /** Read exactly the text length described by a page, in bounded decoded chunks. */
  async *text(source: TextSource, options: RequestOptions = {}): AsyncGenerator<string> {
    const parsed = TextSource.safeParse(source);
    if (!parsed.success || parsed.data.bytes % 2) throw new ClientError("protocol");
    let offset = 0;
    let carry = "";
    while (offset < parsed.data.bytes) {
      const result = await this.outputRead(
        {
          streamId: parsed.data.streamId,
          offset,
          limit: Math.min(256 * 1024, parsed.data.bytes - offset),
        },
        options,
      );
      if (!result.bytes.length || result.bytes.length % 2) throw new ClientError("stale");
      offset = result.nextOffset;
      const decoded = decodeUtf16(result.bytes, carry);
      carry = offset === parsed.data.bytes ? "" : decoded.carry;
      const text = offset === parsed.data.bytes ? decoded.text + decoded.carry : decoded.text;
      if (text.length) yield text;
    }
  }
  async *output(
    payload: { streamId: string; offset: number; limit: number },
    options: RequestOptions = {},
  ): AsyncGenerator<Uint8Array> {
    let offset = payload.offset;
    for (;;) {
      const result = await this.outputRead({ ...payload, offset }, options);
      if (result.bytes.length) yield result.bytes;
      if (result.eof) return;
      offset = result.nextOffset;
    }
  }
}

function decodeThreadId(id: string): ThreadId {
  const result = ThreadId.safeParse(id);
  if (!result.success) throw new ClientError("protocol", "Invalid thread id");
  return result.data;
}
