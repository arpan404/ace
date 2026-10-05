import {
  ClientError,
  Notifications,
  type ClientApi,
  type RequestOptions,
  type Selection,
  type ServiceRequest,
  type OneWayMessage,
} from "@ace/client";
import {
  MachineDirectory,
  MachineThreads,
  type MachineEntry,
  type MachineThreadRef,
  type PairedMachine,
} from "@ace/client/machines";
import type { CommandPayload, HostIdentity } from "@ace/protocol";
import { RemoteClient, type RemoteOptions } from "./remote.ts";
import type { PortLike } from "./wire.ts";

export type MachineStatus = "online" | "connecting" | "offline" | "auth_failed";
export interface MachineState {
  entry: MachineEntry;
  status: MachineStatus;
  identity?: HostIdentity;
  error?: ClientError;
}
/** One dedicated worker per endpoint. No worker may be reused between machine entries. */
export interface MachineWorker {
  port: PortLike;
  /** Volatile config for that worker's ClientHost; tokens must never be logged/persisted. */
  config: unknown;
  /** Synchronously terminate the worker, even if its event loop is blocked. */
  terminate(): void;
  /** Report worker/channel failure without depending on its blocked event loop. */
  onFailure(listener: (error: ClientError) => void): () => void;
}
export interface MachinePoolOptions {
  directory: MachineDirectory;
  /** Spawn a separate worker with Client.expectedHostId = entry.hostId and a host/device outbox. */
  spawn(entry: MachineEntry, token: string): MachineWorker;
  remote: RemoteOptions;
}
interface Live {
  state: MachineState;
  worker?: MachineWorker;
  client?: RemoteClient;
  stop?: () => void;
  stopFailure?: () => void;
  verification: number;
  attached: boolean;
  enabled: boolean;
  removing: boolean;
}
type ThreadCommand = Exclude<CommandPayload, { type: "thread.create" | "thread.prepare" }>;
type CreateCommand = Extract<CommandPayload, { type: "thread.create" | "thread.prepare" }>;
/** Keep all routed controls on the reference's thread before they reach any worker. */
function assertThread(
  ref: MachineThreadRef,
  input: ThreadCommand | ServiceRequest | OneWayMessage,
): void {
  const threadId =
    input.type === "browser.open"
      ? input.options.threadId
      : "threadId" in input
        ? input.threadId
        : undefined;
  if (threadId !== undefined && threadId !== ref.threadId)
    throw new ClientError("protocol", "Thread routing mismatch");
}

/** Client-owned directory and isolated worker connections. Import only for multi-machine boot. */
export class MachinePool {
  readonly threads = new MachineThreads();
  private options: MachinePoolOptions;
  private live = new Map<string, Live>();
  private notifications = new Notifications(4096);
  private order: readonly string[] = [];
  private closed = false;
  private starting: Promise<void> | undefined;
  constructor(options: MachinePoolOptions) {
    this.options = options;
  }
  get ids(): readonly string[] {
    return this.order;
  }
  machine(hostId: string): MachineState | undefined {
    return this.live.get(hostId)?.state;
  }
  select<T>(
    keys: readonly string[],
    read: (pool: MachinePool) => T,
    equal?: (a: T, b: T) => boolean,
  ): Selection<T> {
    return this.notifications.select(keys, () => read(this), equal);
  }
  status(hostId: string): Selection<MachineState | undefined> {
    return this.select([`machine:${hostId}`], (pool) => pool.machine(hostId));
  }
  /** Resolves after metadata loads. Machines start independently; offline hosts cannot gate boot. */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new ClientError("offline"));
    return (this.starting ??= this.options.directory.load().then((entries) => {
      if (this.closed) return;
      for (const entry of entries) this.connect(entry);
    }));
  }
  async add(paired: PairedMachine): Promise<MachineEntry> {
    await this.start();
    this.assertOpen();
    const entry = await this.options.directory.add(paired);
    if (!this.closed) this.connect(entry);
    return entry;
  }
  async pair(
    link: string,
    redeem: (link: string) => Promise<PairedMachine>,
  ): Promise<MachineEntry> {
    return this.add(await redeem(link));
  }
  async rename(hostId: string, displayName: string): Promise<void> {
    await this.start();
    this.assertOpen();
    await this.options.directory.rename(hostId, displayName);
    const entry = this.options.directory.machines.find((candidate) => candidate.hostId === hostId);
    const live = this.live.get(hostId);
    if (!entry || !live) return;
    this.publish(live, { ...live.state, entry });
    this.threads.rename(entry);
  }
  async remove(hostId: string): Promise<void> {
    await this.start();
    this.assertOpen();
    const live = this.live.get(hostId);
    if (live?.removing) throw new ClientError("storage", "Machine removal pending");
    if (live) {
      // Disable every async continuation and retained client handle before secret-store I/O.
      live.enabled = false;
      live.removing = true;
      this.stopWorker(live);
      this.publish(live, { entry: live.state.entry, status: "offline" });
    }
    try {
      await this.options.directory.remove(hostId);
    } catch {
      const error = new ClientError("storage", "Machine directory removal failed");
      if (live && !this.closed)
        this.publish(live, { entry: live.state.entry, status: "offline", error });
      throw error;
    } finally {
      if (live) live.removing = false;
    }
    if (!live || this.closed) return;
    this.live.delete(hostId);
    this.order = this.order.filter((id) => id !== hostId);
    this.dispose(live);
    this.notifications.emit(["ids", `machine:${hostId}`]);
  }
  /** Retry after authorization replacement or a worker failure, retaining cached thread facts. */
  reconnect(hostId: string): void {
    this.assertOpen();
    const previous = this.live.get(hostId);
    if (!previous) throw new ClientError("offline", "Unknown machine");
    if (previous.removing) throw new ClientError("storage", "Machine removal pending");
    if (previous.state.status === "connecting" || previous.state.status === "online") return;
    this.stopWorker(previous);
    this.connect(previous.state.entry);
  }
  /** All service families, projects, file transfers and one-way controls stay host scoped. */
  client(hostId: string): ClientApi {
    const live = this.live.get(hostId);
    if (this.closed || !live?.client || live.state.status !== "online")
      throw new ClientError(live?.state.status === "auth_failed" ? "auth" : "offline");
    return live.client;
  }
  /** Route any thread-scoped API through this client, including cold reads and subscriptions. */
  clientForThread(ref: MachineThreadRef): ClientApi {
    return this.client(ref.hostId);
  }
  thread(ref: MachineThreadRef) {
    return this.clientForThread(ref).thread(ref.threadId);
  }
  command(ref: MachineThreadRef, payload: ThreadCommand, options?: RequestOptions, id?: string) {
    assertThread(ref, payload);
    return this.clientForThread(ref).command(payload, options, id);
  }
  enqueue(ref: MachineThreadRef, payload: ThreadCommand, id?: string) {
    assertThread(ref, payload);
    return this.clientForThread(ref).enqueue(payload, id);
  }
  request<Q extends ServiceRequest>(ref: MachineThreadRef, input: Q, options?: RequestOptions) {
    assertThread(ref, input);
    return this.clientForThread(ref).request(input, options);
  }
  send(ref: MachineThreadRef, message: OneWayMessage): void {
    assertThread(ref, message);
    this.clientForThread(ref).send(message);
  }
  /** The caller must choose a machine before creating a thread. */
  create(hostId: string, payload: CreateCommand, options?: RequestOptions, id?: string) {
    return this.client(hostId).command(payload, options, id);
  }
  projects(hostId: string) {
    return this.client(hostId).projects;
  }
  networkOnline(hostId: string, online: boolean): void {
    this.live.get(hostId)?.client?.networkOnline(online);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const live of this.live.values()) this.dispose(live);
    this.live.clear();
    this.order = [];
    this.notifications.emitAll();
  }
  private assertOpen(): void {
    if (this.closed) throw new ClientError("offline");
  }
  private publish(live: Live, state: MachineState): void {
    live.state = state;
    this.notifications.emit([`machine:${state.entry.hostId}`]);
  }
  private connect(entry: MachineEntry): void {
    const live: Live = {
      state: { entry, status: "connecting" },
      verification: 0,
      attached: false,
      enabled: true,
      removing: false,
    };
    this.live.set(entry.hostId, live);
    this.threads.register(entry);
    if (!this.order.includes(entry.hostId)) this.order = [...this.order, entry.hostId];
    this.notifications.emit(["ids", `machine:${entry.hostId}`]);
    // Credential access, worker startup and identity verification never share a host queue.
    void this.open(live).catch((error: unknown) => {
      if (!this.current(live)) return;
      this.publish(live, {
        entry: live.state.entry,
        status: error instanceof ClientError && error.code === "auth" ? "auth_failed" : "offline",
        error: error instanceof ClientError ? error : new ClientError("daemon"),
      });
    });
  }
  private current(live: Live): boolean {
    return !this.closed && live.enabled && this.live.get(live.state.entry.hostId) === live;
  }
  private async open(live: Live): Promise<void> {
    const token = await this.options.directory.token(live.state.entry);
    if (!this.current(live)) return;
    const worker = this.options.spawn(live.state.entry, token);
    live.worker = worker;
    live.stopFailure = worker.onFailure((error) => {
      if (!this.current(live)) return;
      this.publish(live, { entry: live.state.entry, status: "offline", error });
      this.stopWorker(live);
    });
    const client = new RemoteClient(worker.port, worker.config, this.options.remote);
    live.client = client;
    const changed = () => {
      if (!this.current(live)) return;
      const epoch = ++live.verification;
      if (client.state !== "ready") {
        this.publish(live, {
          entry: live.state.entry,
          status:
            client.state === "fatal" && client.error?.code === "auth"
              ? "auth_failed"
              : client.state === "connecting" || client.state === "reconnecting"
                ? "connecting"
                : "offline",
          ...(client.error ? { error: client.error } : {}),
        });
        return;
      }
      void client.request({ type: "host.identity" }).then(
        (reply) => {
          if (!this.current(live) || live.verification !== epoch) return;
          if (reply.identity.hostId !== live.state.entry.hostId) {
            this.publish(live, {
              entry: live.state.entry,
              status: "auth_failed",
              error: new ClientError("auth", "Daemon identity changed"),
            });
            this.stopWorker(live);
            return;
          }
          this.publish(live, {
            entry: live.state.entry,
            status: "online",
            identity: reply.identity,
          });
          if (!live.attached) {
            live.attached = true;
            this.threads.attach(live.state.entry, client.threads());
          }
        },
        (error: unknown) => {
          if (!this.current(live) || live.verification !== epoch) return;
          this.publish(live, {
            entry: live.state.entry,
            status: "offline",
            error: error instanceof ClientError ? error : new ClientError("daemon"),
          });
        },
      );
    };
    live.stop = client.connectionState().subscribe(changed);
    await client.start();
    if (client.state === "ready" && live.verification === 0) changed();
  }
  private dispose(live: Live): void {
    this.threads.detach(live.state.entry.hostId);
    this.stopWorker(live);
  }
  private stopWorker(live: Live): void {
    ++live.verification;
    live.stop?.();
    live.stopFailure?.();
    if (live.client) void live.client.close().catch(() => {});
    live.worker?.terminate();
    delete live.stop;
    delete live.stopFailure;
    delete live.client;
    delete live.worker;
  }
}
