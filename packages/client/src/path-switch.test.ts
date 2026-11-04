import { expect, test } from "vitest";
import { DeviceId, ThreadId } from "@ace/protocol";
import { ClientCore, defaultLimits, type Scheduler, type TransportEvents } from "./index.ts";
import { Multipath, type MachineRoute } from "./multipath.ts";
import type { MachinePathKind } from "@ace/protocol";

/*
 * Fake paths to one fake daemon: each path's sockets answer hello with a welcome and ping with
 * pong, and record what the client sent, so a switch or failover is driven frame by frame.
 */

const hostId = "30f6c4b7-ee27-4793-8c80-7613f816a314";
const threadId = ThreadId.parse("thread");
const token = "a".repeat(64);
type Sent = { type: string; [key: string]: unknown };

class Clock implements Scheduler {
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

class Socket {
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

class Path {
  sockets: Socket[] = [];
  /** The daemon the next welcome names. */
  welcomes = hostId;
  /** Whether new sockets on this path open at all. */
  up = true;
  /** Whether pongs come back. */
  answers = true;
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
            queueMicrotask(() => events.open());
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
                }),
              );
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
const settle = async () => {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function connected(first: MachinePathKind, kinds: MachinePathKind[]) {
  const clock = new Clock();
  const paths = new Map(kinds.map((kind) => [kind, new Path(kind)]));
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

const commands = (socket: Socket) =>
  socket.sent.flatMap((message) =>
    message.type === "command"
      ? [(message.command as { payload: { type: string } }).payload.type]
      : [],
  );
const receipt = (socket: Socket, type: string) => {
  const command = socket.sent.find(
    (message) =>
      message.type === "command" &&
      (message.command as { payload: { type: string } }).payload.type === type,
  )?.command as { id: string } | undefined;
  if (!command) throw new Error(`No ${type} command`);
  socket.deliver({ type: "commandResult", commandId: command.id, ok: true });
};

test("a newer command never overtakes one the old path still owes a receipt for", async () => {
  const { clock, client, multipath, path, route } = await connected("relay", ["relay", "lan"]);
  const relay = path("relay").last;
  // The old path never answers the archive.
  void client.command({ type: "thread.archive", threadId });
  await settle();
  expect(commands(relay)).toEqual(["thread.archive"]);

  expect(await multipath.switchTo(route("lan"))).toBe(true);
  const lan = path("lan").sockets[0];
  if (!lan) throw new Error("No LAN socket");
  void client.command({ type: "thread.unarchive", threadId });
  await settle();
  // The unarchive waits while the old path drains, so the archive can't land after it.
  expect(commands(lan)).toEqual([]);

  clock.advance(2_000);
  await settle();
  expect(commands(lan)).toEqual(["thread.archive", "thread.unarchive"]);
  expect(client.state).toBe("ready");
});

test("a command answered on the old path while it drains lets newer ones go at once", async () => {
  const { client, multipath, path, route } = await connected("relay", ["relay", "lan"]);
  const relay = path("relay").last;
  void client.command({ type: "thread.archive", threadId });
  await settle();
  expect(await multipath.switchTo(route("lan"))).toBe(true);
  const lan = path("lan").sockets[0];
  if (!lan) throw new Error("No LAN socket");
  void client.command({ type: "thread.unarchive", threadId });
  await settle();
  expect(commands(lan)).toEqual([]);

  receipt(relay, "thread.archive");
  await settle();
  // Answered where it was sent: it isn't asked again, and the newer one goes right away.
  expect(commands(lan)).toEqual(["thread.unarchive"]);
});

test("a reconnect that reaches another daemon drops that path and connects over the others", async () => {
  const { clock, client, multipath, path, mismatched } = await connected("relay", ["relay", "lan"]);
  path("lan").up = false;
  path("relay").welcomes = "6b1d2f9e-0d3a-4c51-9a8e-2b7f4c1e0a99";
  const states: string[] = [];
  client.connectionState().subscribe(() => states.push(client.state));

  path("relay").last.drop();
  for (let round = 0; round < 4; round++) {
    clock.advance(1_000);
    await settle();
  }
  expect(mismatched).toEqual(["relay"]);
  expect(states).not.toContain("ready");

  // The other path comes back: the connection uses it, never the one that named another daemon.
  path("lan").up = true;
  const relaySockets = path("relay").sockets.length;
  for (let round = 0; round < 8 && client.state !== "ready"; round++) {
    clock.advance(30_000);
    await settle();
  }
  expect(client.state).toBe("ready");
  expect(multipath.active?.kind).toBe("lan");
  expect(path("relay").sockets.length).toBe(relaySockets);
});

test("an alert the warm standby heard before a failover is shown once", async () => {
  const { client, multipath, path } = await connected("lan", ["lan", "relay"]);
  await settle();
  const standby = path("relay").last;
  expect(standby.sent.map((message) => message.type)).toEqual(["hello", "presence.update"]);
  expect(standby.sent[1]).toMatchObject({ appState: "background" });

  const alerts: string[] = [];
  client.onMessage((message) => {
    if (message.type === "notification") alerts.push(message.notification.id);
  });
  const alert = {
    type: "notification",
    notification: {
      id: "alert-1",
      threadId: "thread",
      title: "Done",
      status: "agent_says",
      backgroundCount: 0,
      actions: [],
    },
  };
  // Both sockets of this device get the alert; the active one shows it.
  path("lan").last.deliver(alert);
  standby.deliver(alert);
  path("lan").last.drop();
  await settle();
  expect(multipath.active?.kind).toBe("relay");
  expect(client.state).toBe("ready");
  // The promoted standby says the app is in the foreground again.
  expect(standby.sent.at(-1)).toMatchObject({ type: "presence.update", appState: "foreground" });
  // The same alert again on the new path, as the old one may have carried it too.
  standby.deliver(alert);
  await settle();
  expect(alerts).toEqual(["alert-1"]);
});

test("a warm standby that fails comes back once its relay recovers", async () => {
  const { clock, multipath, path } = await connected("lan", ["lan", "relay"]);
  await settle();
  const relay = path("relay");
  expect(relay.sockets).toHaveLength(1);

  relay.up = false;
  relay.last.drop();
  await settle();
  // It rests, then tries again; while the relay stays down every try fails.
  clock.advance(1_000);
  await settle();
  expect(relay.sockets.length).toBeGreaterThan(1);
  expect(relay.last.closed).toBe(true);

  relay.up = true;
  for (let round = 0; round < 8 && relay.last.closed; round++) {
    clock.advance(4_000);
    await settle();
  }
  const standby = relay.last;
  expect(standby.closed).toBe(false);
  expect(standby.sent[0]).toMatchObject({ type: "hello" });

  // And it is a real standby: the LAN dropping fails over onto it.
  path("lan").last.drop();
  await settle();
  expect(multipath.active?.kind).toBe("relay");
});
