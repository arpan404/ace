import { Client, type ClientApi, type Scheduler, type ThreadSource } from "@ace/client";
import {
  FakeDaemon,
  ScenarioPlayer,
  fakeTransport,
  flakyCheckout,
  longHistory,
} from "@ace/fake-daemon";
import { DeviceId, ThreadId } from "@ace/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { ClientHost, RemoteClient } from "./index.ts";

const timers: Scheduler = {
  set(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A worker host serving tabs over real MessageChannels, backed by one fake daemon. */
function world(snapshotItems?: number) {
  let now = 1;
  let ids = 0;
  const daemon = new FakeDaemon({
    clock: () => (now += 1),
    ...(snapshotItems ? { snapshotItems } : {}),
  });
  const sockets = { opened: 0, open: 0 };
  const host = new ClientHost({
    target(config) {
      const { daemon: key } = z.object({ daemon: z.string() }).parse(config);
      return {
        key,
        create: () =>
          new Client({
            deviceId: DeviceId.parse("worker-device"),
            transport: () => {
              const inner = fakeTransport(daemon);
              return {
                open(events) {
                  sockets.opened++;
                  sockets.open++;
                  inner.open(events);
                },
                send: (text) => inner.send(text),
                close() {
                  sockets.open--;
                  inner.close();
                },
              };
            },
            credential: async () => daemon.token,
            storage: { load: async () => null, save: async () => {} },
            scheduler: timers,
            random: () => 0.5,
            id: () => `id-${++ids}`,
          }),
      };
    },
    scheduler: timers,
    now: () => Date.now(),
    frameMs: 4,
    lingerMs: 30,
    silenceMs: 300,
  });
  const tab = (target = "local") => {
    const { port1, port2 } = new MessageChannel();
    host.attach(port1);
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
      },
    );
    cleanups.push(() => remote.close());
    const show = (visible: boolean) => {
      page.visible = visible;
      page.changed();
    };
    return Object.assign(remote, { show });
  };
  return { daemon, host, sockets, tab };
}

const textOf = (store: ThreadSource, id: string) => {
  const item = store.item(id);
  return item?.type === "message"
    ? item.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
    : undefined;
};
/** Every message in the window, as text, oldest first. */
const transcript = (store: ThreadSource) => store.order.map((id) => textOf(store, id) ?? id);

async function inProcess(daemon: FakeDaemon) {
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
const settled = (client: ClientApi) => vi.waitFor(() => expect(client.state).toBe("ready"));

test("a tab sees the thread the worker's client streams, delta by delta", async () => {
  const { daemon, tab } = world();
  const script = new ScenarioPlayer(daemon, flakyCheckout());
  const remote = tab();
  await remote.start();
  const lease = remote.thread(script.threadId);
  const reference = (await inProcess(daemon)).thread(script.threadId);
  script.runUntilBlocked();
  await vi.waitFor(() => {
    expect(reference.store.order.length).toBeGreaterThan(3);
    expect(transcript(lease.store)).toEqual(transcript(reference.store));
    expect(lease.store.thread?.title).toBe(reference.store.thread?.title);
    expect(lease.store.agentIds()).toEqual(reference.store.agentIds());
  });
  lease.release();
  reference.release();
});

test("selectors in a tab hear only the keys the worker's store changed", async () => {
  const { daemon, tab } = world();
  const script = new ScenarioPlayer(daemon, flakyCheckout());
  script.step();
  script.step();
  const remote = tab();
  await remote.start();
  const lease = remote.thread(script.threadId);
  await vi.waitFor(() => expect(lease.store.order.length).toBeGreaterThan(0));
  const first = lease.store.order[0] ?? "";
  const selection = lease.store.select([`item:${first}`], (reader) => reader.item(first));
  const heard = vi.fn();
  const stop = selection.subscribe(heard);
  const before = selection.getSnapshot();
  script.runUntilBlocked();
  await vi.waitFor(() => expect(lease.store.order.length).toBeGreaterThan(3));
  expect(selection.getSnapshot()).toBe(before);
  expect(heard).not.toHaveBeenCalled();
  stop();
  lease.release();
});

test("tabs attached to one daemon share a single socket", async () => {
  const { daemon, sockets, tab } = world();
  const script = new ScenarioPlayer(daemon, flakyCheckout());
  const first = tab();
  const second = tab();
  await Promise.all([first.start(), second.start()]);
  await Promise.all([settled(first), settled(second)]);
  const a = first.thread(script.threadId);
  const b = second.thread(script.threadId);
  script.runUntilBlocked();
  await vi.waitFor(() => {
    expect(a.store.order.length).toBeGreaterThan(3);
    expect(transcript(b.store)).toEqual(transcript(a.store));
  });
  expect(sockets.opened).toBe(1);
  a.release();
  b.release();
});

test("the socket closes shortly after the last tab leaves, not while one remains", async () => {
  const { sockets, tab } = world();
  const first = tab();
  const second = tab();
  await Promise.all([first.start(), second.start()]);
  await settled(first);
  await first.close();
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(sockets.open).toBe(1);
  await second.close();
  await vi.waitFor(() => expect(sockets.open).toBe(0));
});

test("a hidden tab receives nothing, then catches up when shown", async () => {
  const { daemon, tab } = world();
  const script = new ScenarioPlayer(daemon, flakyCheckout());
  const remote = tab();
  await remote.start();
  const lease = remote.thread(script.threadId);
  await vi.waitFor(() => expect(lease.store.thread).toBeDefined());
  remote.show(false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const shown = transcript(lease.store);
  script.runUntilBlocked();
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(transcript(lease.store)).toEqual(shown);
  const reference = (await inProcess(daemon)).thread(script.threadId);
  remote.show(true);
  await vi.waitFor(() => {
    expect(reference.store.order.length).toBeGreaterThan(3);
    expect(transcript(lease.store)).toEqual(transcript(reference.store));
  });
  lease.release();
  reference.release();
});

test("a command sent from a tab is acknowledged and its effect streams back", async () => {
  const { daemon, tab } = world();
  const script = new ScenarioPlayer(daemon, longHistory(3));
  script.runUntilBlocked();
  const remote = tab();
  await remote.start();
  await settled(remote);
  const lease = remote.thread(script.threadId);
  await vi.waitFor(() => expect(lease.store.order.length).toBeGreaterThan(0));
  const id = await remote.enqueue({
    type: "thread.send",
    threadId: ThreadId.parse(script.threadId),
    input: [{ type: "text", text: "Also bump the retry budget" }],
    delivery: "queue",
  });
  const intent = remote.intent(id);
  const stop = intent.subscribe(() => {});
  await vi.waitFor(() => expect(intent.getSnapshot()?.state).toBe("acked"));
  await vi.waitFor(() =>
    expect(transcript(lease.store).some((text) => text.includes("retry budget"))).toBe(true),
  );
  stop();
  lease.release();
});

test("older history loads through the worker into the tab's window", async () => {
  const { daemon, tab } = world(40);
  const script = new ScenarioPlayer(daemon, longHistory(60));
  script.runUntilBlocked();
  const remote = tab();
  await remote.start();
  await settled(remote);
  const lease = remote.thread(script.threadId);
  await vi.waitFor(() => expect(lease.store.order).toHaveLength(40));
  expect(transcript(lease.store)[0]).toMatch(/^Question 41:/);
  await remote.loadOlder(script.threadId, 30);
  await vi.waitFor(() => expect(lease.store.order).toHaveLength(70));
  expect(transcript(lease.store)[0]).toMatch(/^Question 26:/);
  expect(lease.store.itemsBefore).toEqual(expect.any(Number));
  lease.release();
});

test("a request the worker cannot satisfy rejects in the tab with the client's error", async () => {
  const { tab } = world();
  const remote = tab();
  await remote.start();
  await settled(remote);
  await expect(remote.loadOlder("thread-nobody-holds", 20)).rejects.toMatchObject({
    code: "offline",
  });
  const controller = new AbortController();
  const pending = remote.command({ type: "diagnostics.health" }, { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "aborted" });
});

test("a tab that stops answering is dropped and the idle connection closes", async () => {
  const { host, sockets } = world();
  const { port1, port2 } = new MessageChannel();
  host.attach(port1);
  // A raw port that connects and leases, then never pings again, like a crashed tab.
  port2.postMessage({ t: "connect", config: { daemon: "local" } });
  port2.postMessage({ t: "lease", lease: 1, scope: { kind: "threads" } });
  cleanups.push(() => port2.close());
  await vi.waitFor(() => expect(sockets.open).toBe(1));
  await vi.waitFor(() => expect(sockets.open).toBe(0), { timeout: 2000 });
  expect(host.clients).toBe(0);
});

test("a setting saved in one tab reaches another tab's subscription through the worker", async () => {
  const { tab } = world();
  const watcher = tab();
  const writer = tab();
  await Promise.all([watcher.start(), writer.start()]);
  await Promise.all([settled(watcher), settled(writer)]);
  const heard: unknown[] = [];
  const stop = watcher.onMessage((message) => {
    if (message.type === "settings.changed" && message.subscriptionId === "sub-default")
      heard.push(...message.entries.map((entry) => [entry.key, entry.value]));
  });
  const subscribed = await watcher.request({
    type: "settings.subscribe",
    subscriptionId: "sub-default",
    keys: ["providers.default"],
    scope: {},
  });
  expect(subscribed.ok).toBe(true);
  const saved = await writer.request({
    type: "settings.set",
    key: "providers.default",
    value: "codex",
    layer: { kind: "global" },
  });
  expect(saved.ok).toBe(true);
  await vi.waitFor(() => expect(heard).toEqual([["providers.default", "codex"]]));
  stop();
  await writer.request({
    type: "settings.set",
    key: "providers.default",
    value: "claude",
    layer: { kind: "global" },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(heard).toHaveLength(1);
});

test("a malformed service request is refused before it reaches the daemon", async () => {
  const { tab } = world();
  const remote = tab();
  await remote.start();
  await settled(remote);
  await expect(
    // @ts-expect-error the key is not a settings key; the client must refuse it at runtime too.
    remote.request({ type: "settings.get", key: 42 }),
  ).rejects.toMatchObject({ code: "protocol" });
});
