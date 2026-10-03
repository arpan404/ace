import {
  HistoryScanStatus,
  HistoryScanResponse,
  HistoryListRequest,
  HistoryListResponse,
} from "@ace/protocol/history";
import { decodeUtf16 } from "./utf16.ts";
import { decodeBase64 } from "./base64.ts";
import {
  QueueResult,
  SettingsResult,
  TextSource,
  RegistryRequest,
  RegistryResult,
  CommandResult,
  ClientMessage,
  ServerMessage,
  ItemsPage,
  type CommandPayload,
  type SettingsKey,
  type SettingsScope,
  type SettingsLayer,
} from "@ace/protocol";
import { Connection } from "./connection.ts";
import { Intents, type Intent } from "./intents.ts";
import { Notifications, type Selection } from "./observable.ts";
import { Requests } from "./requests.ts";
import { Sidebar } from "./sidebar.ts";
import { Subscriptions, type ThreadSubscription } from "./subscriptions.ts";
import {
  ClientError,
  defaultLimits,
  type ClientOptions,
  type RequestOptions,
  type ConnectionState,
} from "./types.ts";

type WithoutRequestId<T> = T extends unknown ? Omit<T, "requestId"> : never;
export type RegistryQuery = WithoutRequestId<RegistryRequest>;

export class Client {
  private options: ClientOptions;
  private connection: Connection;
  private requests: Requests;
  private subscriptions: Subscriptions;
  private sidebar: Sidebar;
  private intents: Intents;
  private notifications: Notifications;
  private historyState: HistoryScanStatus | undefined;
  private closed = false;
  private hostId: string | undefined;
  constructor(options: ClientOptions) {
    this.options = options;
    const limits = { ...defaultLimits, ...options.limits };
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value <= 0) throw new ClientError("limit");
    if (limits.threads > 63)
      throw new ClientError("limit", "Reserve one of 64 subscriptions for the sidebar");
    this.notifications = new Notifications(limits.listeners);
    this.requests = new Requests(options.scheduler, limits.requests, limits.requestMs);
    this.connection = new Connection(
      options,
      limits,
      (message) => {
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
            if (message.requestId) this.requests.resolve(message.requestId, message);
            break;
          case "queue.result":
          case "settings.result":
          case "registry.result":
          case "items.page":
          case "output.data":
            this.requests.resolve(message.requestId, message);
            break;
          case "error":
            if (message.requestId)
              this.requests.reject(message.requestId, new ClientError("daemon", message.code));
            else if (message.subscriptionId) {
              const error = new ClientError("daemon", message.code);
              this.subscriptions.reject(message.subscriptionId, error);
              this.sidebar.reject(message.subscriptionId, error);
            } else this.connection.fail(new ClientError("daemon", message.code));
            break;
          default:
            this.subscriptions.receive(message);
            this.sidebar.receive(message);
        }
      },
      () => this.notifications.emit(["connection"]),
      () => {
        this.requests.clear(new ClientError("offline"));
        this.subscriptions.disconnect();
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
    this.intents = new Intents(
      options.storage,
      options.deviceId,
      limits.intents,
      limits.outboxBytes,
      limits.sendBytes,
      (id) => this.notifications.emit([`intent:${id}`]),
      (command) => {
        if (this.state === "ready") this.connection.send({ type: "command", command });
      },
    );
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
  intent(id: string): Selection<Intent | undefined> {
    return this.notifications.select([`intent:${id}`], () => this.intents.get(id));
  }
  async start(): Promise<void> {
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
  command(
    payload: CommandPayload,
    options: RequestOptions = {},
    id = this.options.id(),
  ): Promise<CommandResult> {
    if (this.state !== "ready" || this.closed) return Promise.reject(new ClientError("offline"));
    return this.requests.wait(id, CommandResult.parse, options, () => {
      void this.enqueue(payload, id).catch((error: unknown) =>
        this.requests.reject(
          id,
          error instanceof ClientError ? error : new ClientError("protocol"),
        ),
      );
    });
  }
  registry(input: RegistryQuery, options: RequestOptions = {}): Promise<RegistryResult> {
    if (this.state !== "ready" || this.closed) return Promise.reject(new ClientError("offline"));
    const request = RegistryRequest.parse({ ...input, requestId: this.options.id() });
    return this.requests.wait(
      request.requestId,
      (value) => {
        const response = RegistryResult.parse(value);
        if (response.requestId !== request.requestId) throw new ClientError("protocol");
        return response;
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
      HistoryScanResponse.parse,
      options,
    );
  }
  historyScanStatus(options: RequestOptions = {}) {
    return this.historyRequest(
      { type: "history.scan", action: "status" },
      HistoryScanResponse.parse,
      options,
    );
  }
  listHistory(
    input: Omit<import("zod").input<typeof HistoryListRequest>, "type" | "requestId">,
    options: RequestOptions = {},
  ) {
    return this.historyRequest(
      { type: "history.list", ...input },
      HistoryListResponse.parse,
      options,
    );
  }
  private historyRequest<T>(
    input:
      | import("zod").input<typeof HistoryListRequest>
      | { type: "history.scan"; action: "start" | "status" },
    decode: (value: unknown) => T,
    options: RequestOptions,
  ): Promise<T> {
    if (this.state !== "ready" || this.closed) return Promise.reject(new ClientError("offline"));
    const requestId = this.options.id();
    const request = ClientMessage.parse({ ...input, requestId });
    return this.requests.wait(requestId, decode, options, () => {
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
      | { type: "items.page"; threadId: string; before: number; limit: number }
      | { type: "settings.get"; key: SettingsKey; scope: SettingsScope }
      | { type: "settings.set"; key: string; value: unknown; layer: SettingsLayer }
      | { type: "output.read"; streamId: string; offset: number; limit: number },
    decode: (value: unknown) => T,
    options: RequestOptions,
  ): Promise<T> {
    if (this.state !== "ready" || this.closed) throw new ClientError("offline");
    const id = this.options.id();
    const parsed = ClientMessage.safeParse({ ...payload, requestId: id });
    if (!parsed.success) throw new ClientError("protocol", "Invalid read parameters");
    return this.requests.wait(id, decode, options, () => {
      if (!this.connection.send(parsed.data)) throw new ClientError("offline");
    });
  }
  queue(threadId: string, options: RequestOptions = {}) {
    return this.queuePage({ threadId }, options);
  }
  settingsGet(key: SettingsKey, scope: SettingsScope = {}, options: RequestOptions = {}) {
    return this.read({ type: "settings.get", key, scope }, SettingsResult.parse, options);
  }
  settingsSet(key: string, value: unknown, layer: SettingsLayer, options: RequestOptions = {}) {
    return this.read({ type: "settings.set", key, value, layer }, SettingsResult.parse, options);
  }
  queuePage(
    payload: { threadId: string; after?: string; expectedRevision?: number; limit?: number },
    options: RequestOptions = {},
  ) {
    return this.read(
      { type: "queue.get", ...payload },
      (value) => QueueResult.parse(value).queue,
      options,
    );
  }
  itemsPage(
    payload: { threadId: string; before?: number | undefined; limit: number },
    options: RequestOptions = {},
  ) {
    return this.read(
      { type: "items.page", ...payload, before: payload.before ?? Number.MAX_SAFE_INTEGER },
      (value) => {
        const page = ItemsPage.parse(value);
        if (page.threadId !== payload.threadId) throw new ClientError("protocol");
        return page;
      },
      options,
    );
  }
  outputRead(
    payload: { streamId: string; offset: number; limit: number },
    options: RequestOptions = {},
  ) {
    return this.read(
      { type: "output.read", ...payload },
      (value) => {
        const result = ServerMessage.parse(value);
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
