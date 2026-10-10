import { Client, ClientCore, type Scheduler, type ThreadSource, type Storage } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { ServerMessage, type ServerMessage as Message, DeviceId } from "@ace/protocol";
import { z } from "zod";
import { ClientHost, RemoteClient, type HostOptions, type RemoteOptions } from "./index.ts";
export const timers: Scheduler = {
  set(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
export const cleanups: (() => unknown)[] = [];

/** A worker host serving tabs over real MessageChannels, backed by one fake daemon. */
export function world(
  snapshotItems?: number,
  hostOptions: Partial<HostOptions> = {},
  projectScheduler?: (callback: () => void) => void,
  outbox?: Storage,
) {
  let now = 1;
  let ids = 0;
  const daemon = new FakeDaemon({
    clock: () => (now += 1),
    ...(snapshotItems ? { snapshotItems } : {}),
    ...(projectScheduler ? { projectScheduler } : {}),
  });
  const sockets = { opened: 0, open: 0 };
  let hostTime = 0;
  const scheduled = new Set<{ at: number; callback(): void }>();
  const hostScheduler: Scheduler = {
    set(delay, callback) {
      const timer = { at: hostTime + delay, callback };
      scheduled.add(timer);
      // Frames have an explicit microtask boundary; liveness and linger use manual time.
      if (delay <= 4)
        queueMicrotask(() => {
          if (scheduled.delete(timer)) callback();
        });
      return () => {
        scheduled.delete(timer);
      };
    },
  };
  const advance = (ms: number) => {
    const until = hostTime + ms;
    for (;;) {
      const timer = [...scheduled]
        .filter((scheduledTimer) => scheduledTimer.at <= until)
        .toSorted((a, b) => a.at - b.at)[0];
      if (!timer) break;
      hostTime = timer.at;
      scheduled.delete(timer);
      timer.callback();
    }
    hostTime = until;
  };
  const received: Message[] = [];
  const waiters: { predicate(message: Message): boolean; resolve(message: Message): void }[] = [];
  const faults = {
    incoming: (_message: Message, text: string, deliver: (text: string) => void) => deliver(text),
    wait(predicate: (message: Message) => boolean): Promise<Message> {
      const found = received.find(predicate);
      return found
        ? Promise.resolve(found)
        : new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
  const host = new ClientHost({
    target(config) {
      const { daemon: key } = z.object({ daemon: z.string() }).parse(config);
      return {
        key,
        create: () =>
          new ClientCore({
            deviceId: DeviceId.parse("worker-device"),
            transport: () => {
              const inner = fakeTransport(daemon);
              return {
                open(events) {
                  sockets.opened++;
                  sockets.open++;
                  inner.open({
                    ...events,
                    message(text) {
                      const message = ServerMessage.parse(JSON.parse(text));
                      received.push(message);
                      for (const waiter of waiters.slice())
                        if (waiter.predicate(message)) {
                          waiters.splice(waiters.indexOf(waiter), 1);
                          waiter.resolve(message);
                        }
                      faults.incoming(message, text, events.message);
                    },
                  });
                },
                send: (text) => inner.send(text),
                close() {
                  sockets.open--;
                  inner.close();
                },
              };
            },
            credential: async () => daemon.token,
            storage: outbox ?? { load: async () => null, save: async () => {} },
            scheduler: timers,
            random: () => 0.5,
            id: () => `id-${++ids}`,
          }),
      };
    },
    scheduler: hostScheduler,
    now: () => hostTime,
    frameMs: 4,
    lingerMs: 30,
    silenceMs: 300,
    ...hostOptions,
  });
  const tab = (target = "local", tabOptions: Partial<RemoteOptions> = {}) => {
    const { port1, port2 } = new MessageChannel();
    const left = Promise.withResolvers<void>();
    const listeners = new Map<
      (event: { data: unknown }) => void,
      (event: { data: unknown }) => void
    >();
    const traffic: unknown[] = [];
    host.attach({
      postMessage: (value) => {
        traffic.push(value);
        port1.postMessage(value);
      },
      start: () => port1.start(),
      close: () => port1.close(),
      addEventListener(type, listener) {
        const wrapped = (event: { data: unknown }) => {
          listener(event);
          if (z.object({ t: z.literal("bye") }).safeParse(event.data).success) left.resolve();
        };
        listeners.set(listener, wrapped);
        port1.addEventListener(type, wrapped);
      },
      removeEventListener(type, listener) {
        const wrapped = listeners.get(listener);
        if (wrapped) port1.removeEventListener(type, wrapped);
      },
    });
    const page = { visible: true, changed: () => {} };
    const remote = new RemoteClient(
      port2,
      { daemon: target },
      {
        scheduler: timers,
        pingMs: 50,
        visibility: {
          visible: () => page.visible,
          watch(changed) {
            page.changed = changed;
            return () => {};
          },
        },
        ...tabOptions,
      },
    );
    cleanups.push(async () => {
      await remote.close();
      await left.promise;
    });
    const show = (visible: boolean) => {
      page.visible = visible;
      page.changed();
    };
    return Object.assign(remote, { show, left: left.promise, traffic });
  };
  cleanups.push(() => advance(1000));
  return { daemon, host, sockets, tab, faults, advance };
}

export const textOf = (store: ThreadSource, id: string) => {
  const item = store.item(id);
  return item?.type === "message"
    ? item.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
    : undefined;
};
/** Every message in the window, as text, oldest first. */
export const transcript = (store: ThreadSource) => store.order.map((id) => textOf(store, id) ?? id);

export async function inProcess(daemon: FakeDaemon) {
  let ids = 0;
  const client = new Client({
    deviceId: DeviceId.parse("reference-device"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: timers,
    random: () => 0.5,
    id: () => `ref-${++ids}`,
  });
  cleanups.push(() => client.close());
  await client.start();
  return client;
}
