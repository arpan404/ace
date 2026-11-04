import {
  ClientError,
  Multipath,
  Notifications,
  knownPaths,
  machineCodeGate,
  type MachineCodeGate,
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
import {
  MachineCodeRefusal,
  type CommandPayload,
  type HostIdentity,
  type MachineIcon,
  type MachinePath,
  type MachinePathKind,
} from "@ace/protocol";
import { RemoteClient, type RemoteOptions } from "./remote.ts";
import {
  accountRoutes,
  accountMachineEntry,
  accountMachineState,
  type AccountMachine,
  type AccountMachineConnection,
  type AccountMachineOptions,
} from "./account-machines.ts";
import type { PortLike } from "./wire.ts";

/** `machine_code`: an account machine waits for the person to enter its code (ADR 0111). */
export type MachineStatus = "online" | "connecting" | "offline" | "auth_failed" | "machine_code";
export interface MachineState {
  entry: MachineEntry;
  status: MachineStatus;
  identity?: HostIdentity;
  error?: ClientError;
  /** The path the connection uses now (ADR 0114), when the machine has more than one. */
  path?: MachinePathKind;
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
  /** Opens machines on the person's ace account through ace's relay (`openAccountMachine`). */
  account?: AccountMachineOptions;
}
interface Live {
  state: MachineState;
  worker?: MachineWorker;
  client?: ClientApi;
  /** Moves an account machine's connection between its paths. */
  paths?: Multipath;
  stop?: () => void;
  stopPath?: (() => void) | undefined;
  stopFailure?: () => void;
  /** Cancels the scheduled automatic reconnect, while one waits. */
  retry?: () => void;
  verification: number;
  attached: boolean;
  enabled: boolean;
  removing: boolean;
}
/** Automatic reconnects back off from 1s to 30s and start over once the machine is online. */
const retryBaseMs = 1_000;
const retryCapMs = 30_000;

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
  /** Failed connections in a row per machine, for the reconnect backoff. */
  private failures = new Map<string, number>();
  /** Account machines' code gates, kept across reconnects so an entered code is sent once. */
  private gates = new Map<string, MachineCodeGate>();
  /** What account machines said about their paths; account machines aren't saved. */
  private accountPaths = new Map<string, readonly MachinePath[]>();
  /**
   * Account machines' daemon ids, first learned over a relay (whose handshake pins the
   * machine's host key): every later connection, on any path, must reach the same daemon.
   */
  private accountDaemons = new Map<string, string>();
  /** Paired machines an open account machine (`by`) stands in for, by daemon id. */
  private superseded = new Map<string, { entry: MachineEntry; by: string }>();
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
    return (this.starting ??= this.options.directory
      .load()
      .then((entries) => {
        if (this.closed) return;
        for (const entry of entries) if (!this.superseded.has(entry.hostId)) this.connect(entry);
      })
      .catch((error: unknown) => {
        this.starting = undefined;
        throw error;
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
  async rename(hostId: string, displayName: string, icon?: MachineIcon): Promise<void> {
    await this.start();
    this.assertOpen();
    await this.options.directory.rename(hostId, displayName, icon);
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
    // A paired machine standing aside for its account entry goes for good.
    this.superseded.delete(hostId);
    if (live) {
      // Disable every async continuation and retained client handle before secret-store I/O.
      live.enabled = false;
      live.removing = true;
      this.stopWorker(live);
      this.publish(live, { entry: live.state.entry, status: "offline" });
    }
    try {
      if (live?.state.entry.target.kind !== "account") await this.options.directory.remove(hostId);
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
    this.failures.delete(hostId);
    this.gates.delete(hostId);
    this.order = this.order.filter((id) => id !== hostId);
    this.dispose(live);
    this.notifications.emit(["ids", `machine:${hostId}`]);
    this.restoreSuperseded(hostId);
  }
  /**
   * Open a machine on the person's ace account (ADR 0111) and add it to the pool like a paired
   * machine: its main conversation goes through ace's hosted relay, pinned to its host id, with
   * a fresh device grant per attempt. When its daemon wants the machine code, the machine's
   * status is `machine_code` and the connection reads `asking` until the code is entered.
   * Opening one that is already open returns a handle to it.
   */
  openAccountMachine(machine: AccountMachine): AccountMachineConnection {
    this.assertOpen();
    const account = this.options.account;
    if (!account) throw new ClientError("auth", "ace account sign-in is unavailable");
    const hostId = machine.hostId;
    let gate = this.gates.get(hostId);
    if (!gate) {
      gate = machineCodeGate(() => account.grant());
      this.gates.set(hostId, gate);
    }
    const current = this.live.get(hostId);
    if (!current) this.connect(accountMachineEntry(machine, account));
    else if (current.state.entry.target.kind !== "account")
      throw new ClientError("identity", "A paired machine already uses this host id");
    const opened = gate;
    return {
      gate: opened,
      get: () => accountMachineState(this.machine(hostId), opened),
      subscribe: (listener) => {
        const stopPool = this.status(hostId).subscribe(listener);
        const stopGate = opened.subscribe(listener);
        return () => {
          stopPool();
          stopGate();
        };
      },
      retry: () => {
        if (this.live.has(hostId)) this.reconnect(hostId);
      },
      enter: (code) => {
        opened.enter(code);
        if (this.live.has(hostId)) this.reconnect(hostId);
      },
      close: () => (this.live.has(hostId) ? this.remove(hostId) : Promise.resolve()),
    };
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
    return this.durableClient(ref.hostId).command(payload, options, id);
  }
  enqueue(ref: MachineThreadRef, payload: ThreadCommand, id?: string) {
    assertThread(ref, payload);
    return this.durableClient(ref.hostId).enqueue(payload, id);
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
    return this.durableClient(hostId).command(payload, options, id);
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
  /** A verified connection can save durable work while its transport is offline. */
  private durableClient(hostId: string): ClientApi {
    const live = this.live.get(hostId);
    if (
      this.closed ||
      !live?.enabled ||
      !live.client ||
      !live.attached ||
      live.state.status === "auth_failed"
    )
      throw new ClientError(live?.state.status === "auth_failed" ? "auth" : "offline");
    return live.client;
  }
  private assertOpen(): void {
    if (this.closed) throw new ClientError("offline");
  }
  private publish(live: Live, state: MachineState): void {
    live.state = state;
    if (state.status === "online") this.failures.delete(state.entry.hostId);
    this.notifications.emit([`machine:${state.entry.hostId}`]);
  }
  /**
   * The connection ended where nothing inside it will try again (its worker died, its client
   * gave up, or its identity check failed): start a fresh one after a backoff, so a machine
   * that comes back shows online without reloading the window. A refused authorization waits
   * for pairing again instead.
   */
  private recover(live: Live): void {
    if (
      !this.current(live) ||
      live.retry ||
      live.state.status === "auth_failed" ||
      live.state.status === "machine_code"
    )
      return;
    const hostId = live.state.entry.hostId;
    const failures = this.failures.get(hostId) ?? 0;
    this.failures.set(hostId, failures + 1);
    const delay = Math.min(retryCapMs, retryBaseMs * 2 ** failures);
    live.retry = this.options.remote.scheduler.set(delay, () => {
      delete live.retry;
      if (!this.current(live) || live.removing) return;
      if (live.state.status === "online" || live.state.status === "auth_failed") return;
      if (live.state.status === "machine_code") return;
      this.stopWorker(live);
      this.connect(live.state.entry);
    });
  }
  /**
   * `daemonId`'s paired entry, if any, steps aside for the account machine `by` that reached
   * the same daemon: a signed-in device is admin on that machine, whatever scopes its pairing
   * gave (ADR 0114). It comes back when the account machine closes.
   */
  private supersede(daemonId: string, by: string): void {
    const paired = this.live.get(daemonId);
    if (!paired || paired.state.entry.target.kind === "account" || paired.removing) return;
    paired.enabled = false;
    this.dispose(paired);
    this.live.delete(daemonId);
    this.failures.delete(daemonId);
    this.order = this.order.filter((id) => id !== daemonId);
    this.superseded.set(daemonId, { entry: paired.state.entry, by });
    this.notifications.emit(["ids", `machine:${daemonId}`]);
  }
  /** The account machine `by` closed: the paired entries it stood in for come back. */
  private restoreSuperseded(by: string): void {
    for (const [daemonId, superseded] of this.superseded) {
      if (superseded.by !== by) continue;
      this.superseded.delete(daemonId);
      if (!this.closed && !this.live.has(daemonId)) this.connect(superseded.entry);
    }
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
        status:
          error instanceof ClientError && (error.code === "auth" || error.code === "identity")
            ? "auth_failed"
            : "offline",
        error: error instanceof ClientError ? error : new ClientError("daemon"),
      });
      this.recover(live);
    });
  }
  private current(live: Live): boolean {
    return !this.closed && live.enabled && this.live.get(live.state.entry.hostId) === live;
  }
  /** A paired machine's client: in its own worker, with its stored device token. */
  private async workerClient(live: Live): Promise<ClientApi | undefined> {
    const token = await this.options.directory.token(live.state.entry);
    if (!this.current(live)) return undefined;
    const worker = this.options.spawn(live.state.entry, token);
    live.worker = worker;
    live.stopFailure = worker.onFailure((error) => {
      if (!this.current(live)) return;
      this.publish(live, { entry: live.state.entry, status: "offline", error });
      this.stopWorker(live);
      this.recover(live);
    });
    return new RemoteClient(worker.port, worker.config, this.options.remote);
  }
  /** An account machine's client, through ace's relay with a fresh grant per attempt. */
  private accountClient(live: Live, relayUrl: string): ClientApi {
    const account = this.options.account;
    const gate = this.gates.get(live.state.entry.hostId);
    if (!account || !gate) throw new ClientError("auth", "ace account sign-in is unavailable");
    const { hostId, deviceId } = live.state.entry;
    const scheduler = this.options.remote.scheduler;
    const routes = accountRoutes({
      relayUrl,
      hostId,
      account,
      gate,
      scheduler,
      paths: () => this.accountPaths.get(hostId) ?? [],
    });
    const paths = new Multipath({
      routes,
      scheduler,
      // The shell's clock; an app that injects none gets the wall clock here, at the boundary.
      now: this.options.remote.now ?? Date.now,
    });
    live.paths = paths;
    const route = paths.route();
    const daemonId = this.accountDaemons.get(hostId);
    const client = account.client({
      hostId,
      deviceId,
      ...(daemonId ? { expectedHostId: daemonId } : {}),
      transport: route.transport,
      credential: route.credential,
    });
    client.usePaths?.(paths);
    return client;
  }
  /**
   * The daemon id an account machine must have: the one already learned, or, when this
   * connection runs over a relay (its handshake pins the machine's host key), the one it
   * reports now, kept from then on. Undefined over a direct path before any relay vouched.
   */
  private accountDaemon(hostId: string, client: ClientApi, daemonId: string): string | undefined {
    const known = this.accountDaemons.get(hostId);
    if (known !== undefined) return known;
    const path = client.activePath?.().getSnapshot();
    if (path !== "account" && path !== "relay") return undefined;
    this.accountDaemons.set(hostId, daemonId);
    return daemonId;
  }
  private async open(live: Live): Promise<void> {
    const target = live.state.entry.target;
    const client =
      target.kind === "account"
        ? this.accountClient(live, target.relayUrl)
        : await this.workerClient(live);
    if (!client || !this.current(live)) {
      if (client) void client.close().catch(() => {});
      return;
    }
    live.client = client;
    live.stopPath = client.activePath?.().subscribe(() => {
      if (!this.current(live)) return;
      const path = client.activePath?.().getSnapshot();
      const { path: _previous, ...rest } = live.state;
      this.publish(live, { ...rest, ...(path ? { path } : {}) });
      if (path && live.state.entry.target.kind !== "account")
        void this.options.directory
          .remember(live.state.entry.hostId, { lastPath: path })
          .catch(() => {});
    });
    const changed = () => {
      if (!this.current(live)) return;
      const epoch = ++live.verification;
      if (client.state !== "ready") {
        this.publish(live, {
          entry: live.state.entry,
          status:
            client.state === "fatal" && client.error?.code === "machine_code"
              ? "machine_code"
              : client.state === "fatal" &&
                  (client.error?.code === "auth" || client.error?.code === "identity")
                ? "auth_failed"
                : client.state === "connecting"
                  ? "connecting"
                  : "offline",
          ...(client.error ? { error: client.error } : {}),
        });
        // A direct path asks for the machine code by closing; the gate shows the question.
        const refusal = MachineCodeRefusal.safeParse(client.error?.message);
        const gate = this.gates.get(live.state.entry.hostId);
        if (client.error?.code === "machine_code" && refusal.success && gate && !gate.asking)
          gate.refused(refusal.data, client.error.lockedUntil);
        // A client that is connecting or offline retries by itself; a fatal one never does.
        if (client.state === "fatal") this.recover(live);
        return;
      }
      void client
        .request({ type: "host.identity" })
        .then(
          async (reply) => {
            if (!this.current(live) || live.verification !== epoch) return;
            // An account machine is known by its relay host id, which the pinned handshake has
            // already proved; its daemon's own id is another value, learned over a relay and
            // then held to on every path.
            const expected =
              live.state.entry.target.kind === "account"
                ? this.accountDaemon(live.state.entry.hostId, client, reply.identity.hostId)
                : live.state.entry.hostId;
            if (expected !== undefined && reply.identity.hostId !== expected) {
              this.publish(live, {
                entry: live.state.entry,
                status: "auth_failed",
                error: new ClientError("auth", "Daemon identity changed"),
              });
              this.stopWorker(live);
              return;
            }
            // Signing in wins over pairing (ADR 0114): the same machine, paired from this
            // device too, steps aside while its account entry is open.
            if (live.state.entry.target.kind === "account" && expected !== undefined)
              this.supersede(expected, live.state.entry.hostId);
            // Account machines come from the account's list, not the saved directory.
            // Paths come only from the machine itself, over this verified connection.
            if (live.state.entry.target.kind !== "account") {
              await this.options.directory.rename(
                live.state.entry.hostId,
                reply.identity.displayName,
                reply.identity.icon,
              );
              if (reply.paths)
                await this.options.directory.remember(live.state.entry.hostId, {
                  paths: knownPaths(reply.paths),
                });
            } else if (reply.paths)
              this.accountPaths.set(live.state.entry.hostId, knownPaths(reply.paths));
            if (!this.current(live) || live.verification !== epoch) return;
            const entry = {
              ...live.state.entry,
              displayName: reply.identity.displayName,
              icon: reply.identity.icon,
            };
            this.publish(live, { entry, status: "online", identity: reply.identity });
            if (live.attached) this.threads.rename(entry);
            else {
              live.attached = true;
              this.threads.attach(entry, client.threads());
            }
          },
          (error: unknown) => {
            if (!this.current(live) || live.verification !== epoch) return;
            this.publish(live, {
              entry: live.state.entry,
              status: "offline",
              error: error instanceof ClientError ? error : new ClientError("daemon"),
            });
            this.recover(live);
          },
        )
        .catch((error: unknown) => {
          if (!this.current(live)) return;
          this.publish(live, {
            entry: live.state.entry,
            status: "offline",
            error: error instanceof ClientError ? error : new ClientError("storage"),
          });
          this.recover(live);
        });
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
    live.retry?.();
    delete live.retry;
    live.stop?.();
    live.stopPath?.();
    live.paths?.close();
    live.stopFailure?.();
    if (live.client) void live.client.close().catch(() => {});
    live.worker?.terminate();
    delete live.stop;
    delete live.stopPath;
    delete live.paths;
    delete live.stopFailure;
    delete live.client;
    delete live.worker;
  }
}
export { accountMachineEntry, accountMachineState } from "./account-machines.ts";
export type {
  AccountMachine,
  AccountMachineConnection,
  AccountMachineOptions,
  AccountMachineState,
} from "./account-machines.ts";
