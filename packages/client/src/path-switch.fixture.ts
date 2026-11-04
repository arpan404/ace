import { expect } from "vitest";
import { DeviceId, HostId, ThreadId } from "@ace/protocol";
import {
  ClientCore,
  defaultLimits,
  type ClientOptions,
  type Scheduler,
  type TransportEvents,
} from "./index.ts";
import { Multipath, type MachineRoute } from "./multipath.ts";
import type { MachinePathKind } from "@ace/protocol";

/*
 * Test-only. Fake paths to one fake daemon: each path's sockets answer hello with a welcome and ping with
 * pong, and record what the client sent, so a switch or failover is driven frame by frame.
 */

export const hostId = "30f6c4b7-ee27-4793-8c80-7613f816a314";
export const threadId = ThreadId.parse("thread");
export const token = "a".repeat(64);
export type Sent = { type: string; [key: string]: unknown };

export class Clock implements Scheduler {
  now = 0;
  #next = 0;
  #timers = new Map<number, { at: number; run(): void }>();
  set(delayMs: number, run: () => void): () => void {
    const id = ++this.#next;
    this.#timers.set(id, { at: this.now + delayMs, run });
    return () => this.#timers.delete(id);
  }
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const next = [...this.#timers]
        .filter(([, timer]) => timer.at <= until)
        .toSorted((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.#timers.delete(next[0]);
      next[1].run();
    }
    this.now = until;
  }
}

export class Socket {
  sent: Sent[] = [];
  events: TransportEvents | undefined;
  closed = false;
  deliver(message: unknown): void {
    if (!this.closed) this.events?.message(JSON.stringify(message));
  }
  drop(code = 1006): void {
    if (this.closed) return;
    this.closed = true;
    this.events?.close(code, "gone");
  }
}

export class Path {
  sockets: Socket[] = [];
  /** The daemon the next welcome names. */
  welcomes = hostId;
  /** Whether new sockets on this path open at all. */
  up = true;
  /** Whether pongs come back. */
  answers = true;
  /** What the welcome says the hello's grant has left, for an account device. */
  grantTtlMs: number | undefined;
  /** How a socket answers `account.grant.refresh`; unanswered when it returns undefined. */
  refresh: (grant: string) => Record<string, unknown> | undefined = () => undefined;
  /** While true, new sockets wait to open until `release` (a slow handshake). */
  held = false;
  #waiting: (() => void)[] = [];
  release(): void {
    this.held = false;
    for (const open of this.#waiting.splice(0)) open();
  }
  readonly kind: MachinePathKind;
  constructor(kind: MachinePathKind) {
    this.kind = kind;
  }
  get last(): Socket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error(`No ${this.kind} socket`);
    return socket;
  }
  route(): MachineRoute {
    return {
      path: { key: this.kind, kind: this.kind },
      credential: async () => token,
      transport: () => {
        const socket = new Socket();
        this.sockets.push(socket);
        return {
          open: (events) => {
            socket.events = events;
            if (!this.up) {
              queueMicrotask(() => socket.drop());
              return;
            }
            if (this.held) this.#waiting.push(() => events.open());
            else queueMicrotask(() => events.open());
          },
          send: (text) => {
            const message = JSON.parse(text) as Sent;
            socket.sent.push(message);
            if (message.type === "hello")
              queueMicrotask(() =>
                socket.deliver({
                  type: "welcome",
                  hostId: this.welcomes,
                  protocolVersion: 1,
                  headSeq: 0,
                  ...(this.grantTtlMs === undefined ? {} : { grantTtlMs: this.grantTtlMs }),
                }),
              );
            if (message.type === "account.grant.refresh") {
              const result = this.refresh(String(message.grant));
              if (result)
                queueMicrotask(() =>
                  socket.deliver({
                    type: "account.grant.refresh.result",
                    requestId: message.requestId,
                    result,
                  }),
                );
            }
            if (message.type === "ping" && this.answers)
              queueMicrotask(() => socket.deliver({ type: "pong" }));
          },
          close: () => {
            socket.closed = true;
          },
        };
      },
    };
  }
}

/** Let promise chains (credentials, welcomes, outbox writes) run. */
export const settle = async () => {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 0));
};

export async function connected(
  first: MachinePathKind,
  kinds: MachinePathKind[],
  options: {
    /** Set each path up before the first connect. */
    prepare?(path: Path): void;
    /** What the client is pinned to (a paired machine, or a recreated account client). */
    expectedHostId?: string;
    /** An account device's fresh grant, for refreshing each socket's. */
    grant?: ClientOptions["grant"];
  } = {},
) {
  const clock = new Clock();
  const paths = new Map(kinds.map((kind) => [kind, new Path(kind)]));
  for (const path of paths.values()) options.prepare?.(path);
  const path = (kind: MachinePathKind) => {
    const found = paths.get(kind);
    if (!found) throw new Error(`No ${kind} path`);
    return found;
  };
  const routes = kinds.map((kind) => path(kind).route());
  const mismatched: string[] = [];
  const multipath = new Multipath({
    routes: () => routes,
    scheduler: clock,
    now: () => clock.now,
    lastWinner: first,
    mismatch: (planned) => mismatched.push(planned.kind),
  });
  const race = multipath.route();
  let id = 0;
  const client = new ClientCore({
    deviceId: DeviceId.parse("device"),
    transport: race.transport,
    credential: race.credential,
    storage: { load: async () => null, save: async () => {} },
    scheduler: clock,
    random: () => 0.5,
    id: () => `id-${++id}`,
    now: () => clock.now,
    limits: defaultLimits,
    ...(options.expectedHostId ? { expectedHostId: HostId.parse(options.expectedHostId) } : {}),
    ...(options.grant ? { grant: options.grant } : {}),
  });
  client.usePaths(multipath);
  await client.start();
  await settle();
  expect(client.state).toBe("ready");
  expect(multipath.active?.kind).toBe(first);
  const route = (kind: MachinePathKind) => {
    const found = routes.find((entry) => entry.path.kind === kind);
    if (!found) throw new Error(`No ${kind} route`);
    return found;
  };
  return { clock, client, multipath, path, route, mismatched };
}

export const commands = (socket: Socket) =>
  socket.sent.flatMap((message) =>
    message.type === "command"
      ? [(message.command as { payload: { type: string } }).payload.type]
      : [],
  );
export const receipt = (socket: Socket, type: string) => {
  const command = socket.sent.find(
    (message) =>
      message.type === "command" &&
      (message.command as { payload: { type: string } }).payload.type === type,
  )?.command as { id: string } | undefined;
  if (!command) throw new Error(`No ${type} command`);
  socket.deliver({ type: "commandResult", commandId: command.id, ok: true });
};
