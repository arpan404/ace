import {
  CommandResult,
  ReadPayload,
  ItemsPage,
  OutputRead,
  type CommandPayload,
  type ReadPayload as Payload,
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

export class Client {
  private options: ClientOptions;
  private connection: Connection;
  private requests: Requests;
  private subscriptions: Subscriptions;
  private sidebar: Sidebar;
  private intents: Intents;
  private notifications: Notifications;
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
          case "response":
            if (message.ok) this.requests.resolve(message.requestId, message.result);
            else this.requests.reject(message.requestId, new ClientError("daemon", message.error));
            break;
          case "error":
            this.connection.fail(new ClientError("daemon", message.code));
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
  private read<T>(
    payload: Payload,
    decode: (value: unknown) => T,
    options: RequestOptions,
  ): Promise<T> {
    if (this.state !== "ready" || this.closed) return Promise.reject(new ClientError("offline"));
    const parsed = ReadPayload.parse(payload);
    const id = this.options.id();
    return this.requests.wait(id, decode, options, () => {
      if (!this.connection.send({ type: "request", requestId: id, payload: parsed }))
        throw new ClientError("offline");
    });
  }
  itemsPage(
    payload: Omit<Extract<Payload, { type: "items.page" }>, "type">,
    options: RequestOptions = {},
  ) {
    return this.read({ type: "items.page", ...payload }, ItemsPage.parse, options);
  }
  outputRead(
    payload: Omit<Extract<Payload, { type: "output.read" }>, "type">,
    options: RequestOptions = {},
  ) {
    return this.read({ type: "output.read", ...payload }, OutputRead.parse, options);
  }
  async *output(
    payload: Omit<Extract<Payload, { type: "output.read" }>, "type">,
    options: RequestOptions = {},
  ): AsyncGenerator<string> {
    let offset = payload.offset;
    for (;;) {
      const result = await this.outputRead({ ...payload, offset }, options);
      if (result.text) yield result.text;
      if (result.done) return;
      if (result.nextOffset <= offset) throw new ClientError("protocol");
      offset = result.nextOffset;
    }
  }
}
