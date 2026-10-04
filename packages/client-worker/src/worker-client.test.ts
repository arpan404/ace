import { Client, type ClientApi, type Scheduler, type ThreadSource } from "@ace/client";
import {
  FakeDaemon,
  ScenarioPlayer,
  fakeTransport,
  flakyCheckout,
  longHistory,
} from "@ace/fake-daemon";
import { ServerMessage, type ServerMessage as Message, DeviceId, ThreadId } from "@ace/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { ClientHost, RemoteClient, type HostOptions, type RemoteOptions } from "./index.ts";

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
function world(
  snapshotItems?: number,
  hostOptions: Partial<HostOptions> = {},
  projectScheduler?: (callback: () => void) => void,
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
          new Client({
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
            storage: { load: async () => null, save: async () => {} },
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
    host.attach({
      postMessage: (value) => port1.postMessage(value),
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
    return Object.assign(remote, { show, left: left.promise });
  };
  cleanups.push(() => advance(1000));
  return { daemon, host, sockets, tab, faults, advance };
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
  const { sockets, tab, advance } = world();
  const first = tab();
  const second = tab();
  await Promise.all([first.start(), second.start()]);
  await settled(first);
  await first.close();
  await first.left;
  advance(80);
  expect(sockets.open).toBe(1);
  await second.close();
  await second.left;
  advance(30);
  expect(sockets.open).toBe(0);
});

test("a hidden tab receives nothing, then catches up when shown", async () => {
  const { daemon, tab } = world();
  const script = new ScenarioPlayer(daemon, flakyCheckout());
  const remote = tab();
  await remote.start();
  const lease = remote.thread(script.threadId);
  await vi.waitFor(() => expect(lease.store.thread).toBeDefined());
  remote.show(false);
  await remote.request({ type: "diagnostics.health" });
  const shown = transcript(lease.store);
  script.runUntilBlocked();
  await remote.request({ type: "diagnostics.health" });
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
  const { host, sockets, advance } = world();
  const { port1, port2 } = new MessageChannel();
  host.attach(port1);
  // A raw port that connects and leases, then never pings again, like a crashed tab.
  port2.postMessage({ t: "connect", config: { daemon: "local" } });
  port2.postMessage({ t: "lease", lease: 1, scope: { kind: "threads" } });
  cleanups.push(() => port2.close());
  await vi.waitFor(() => expect(sockets.open).toBe(1));
  const barrier = Promise.withResolvers<void>();
  port2.addEventListener("message", (event) => {
    if (z.object({ t: z.literal("reply"), call: z.literal(100) }).safeParse(event.data).success)
      barrier.resolve();
  });
  port2.postMessage({
    t: "call",
    call: 100,
    method: "request",
    args: [{ type: "diagnostics.health" }, {}],
  });
  await barrier.promise;
  advance(480);
  expect(sockets.open).toBe(0);
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
  await writer.request({ type: "diagnostics.health" });
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

test("terminal output held for credit resumes when a tab grants credit through the worker", async () => {
  const { daemon, tab } = world();
  daemon.createThread({
    id: "thread-shell",
    workspaceId: "acme-relay",
    title: "Shell",
    provider: "codex",
  });
  const threadId = ThreadId.parse("thread-shell");
  const remote = tab();
  await remote.start();
  await settled(remote);
  const output: string[] = [];
  const stop = remote.onMessage((message) => {
    if (message.type === "terminal.output" && message.event.type === "data")
      output.push(message.event.data);
  });
  const opened = await remote.request({
    type: "terminal.request",
    operation: { op: "open", threadId },
  });
  if (!opened.terminal) throw new Error("Expected a terminal");
  const terminalId = opened.terminal.id;
  await remote.request({
    type: "terminal.request",
    operation: { op: "subscribe", threadId, terminalId, subscriptionId: "shell" },
  });
  await vi.waitFor(() => expect(output).toHaveLength(1));
  await remote.request({
    type: "terminal.request",
    operation: { op: "write", threadId, terminalId, data: "echo relay\r" },
  });
  await remote.request({ type: "diagnostics.health" });
  expect(output).toHaveLength(1);

  remote.send({ type: "terminal.credit", subscriptionId: "shell" });
  await vi.waitFor(() => expect(output.join("")).toContain("relay"));
  stop();
});

test("a one-way control is refused, not queued, while the worker's client is disconnected", async () => {
  const { daemon, tab } = world();
  const remote = tab();
  await remote.start();
  await settled(remote);
  daemon.disconnectAll();
  await vi.waitFor(() => expect(remote.state).not.toBe("ready"));
  expect(() => remote.send({ type: "terminal.credit", subscriptionId: "shell" })).toThrow(
    expect.objectContaining({ code: "offline" }),
  );
});

/** Web Locks in memory: a lock is free once its holder lets go; a waiter hears it then. */
function lockManager() {
  const held = new Map<string, { release(): void; waiters: (() => void)[] }>();
  return {
    liveness: {
      async hold() {
        const name = `tab-${held.size + 1}`;
        const lock = {
          waiters: [] as (() => void)[],
          release: () => {
            held.delete(name);
            for (const waiter of lock.waiters) waiter();
          },
        };
        held.set(name, lock);
        return { name, release: lock.release };
      },
    },
    lockReleased(name: string, gone: () => void) {
      const lock = held.get(name);
      if (!lock) {
        gone();
        return () => {};
      }
      lock.waiters.push(gone);
      return () => {
        lock.waiters = lock.waiters.filter((waiter) => waiter !== gone);
      };
    },
    /** The tab's process dies: its lock frees without a goodbye. */
    crash: (name: string) => held.get(name)?.release(),
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a hidden tab whose timers are throttled keeps its leases and catches up when shown", async () => {
  const { daemon, tab, sockets, advance } = world(undefined, { hiddenSilenceMs: 5_000 });
  const script = new ScenarioPlayer(daemon, flakyCheckout());
  // Pings stop altogether, as in a hidden page the browser has throttled or frozen.
  const remote = tab("local", { pingMs: 60_000 });
  await remote.start();
  const lease = remote.thread(script.threadId);
  await vi.waitFor(() => expect(lease.store.thread).toBeDefined());
  remote.show(false);
  await pause(20);
  // Longer than a visible tab may stay silent, shorter than a hidden one.
  advance(800);
  expect(sockets.open).toBe(1);
  script.runUntilBlocked();
  const reference = (await inProcess(daemon)).thread(script.threadId);
  remote.show(true);
  await vi.waitFor(() => {
    expect(reference.store.order.length).toBeGreaterThan(3);
    expect(transcript(lease.store)).toEqual(transcript(reference.store));
  });
  lease.release();
  reference.release();
});

test("a tab holding its liveness lock is never dropped for silence, and is released when it dies", async () => {
  const locks = lockManager();
  const { host, sockets, advance } = world(undefined, { lockReleased: locks.lockReleased });
  const { port1, port2 } = new MessageChannel();
  host.attach(port1);
  const remote = new RemoteClient(
    port2,
    { daemon: "local" },
    { scheduler: timers, pingMs: 60_000, liveness: locks.liveness },
  );
  cleanups.push(() => remote.close());
  await remote.start();
  remote.threads();
  await vi.waitFor(() => expect(sockets.open).toBe(1));
  await pause(20);
  advance(800);
  expect(sockets.open).toBe(1);
  // The tab's process dies: no goodbye, only its lock frees.
  locks.crash("tab-1");
  advance(100);
  expect(sockets.open).toBe(0);
  expect(host.clients).toBe(0);
});

test("a tab hidden through a long stream catches up exactly when shown", async () => {
  const { daemon, tab } = world();
  const script = new ScenarioPlayer(daemon, longHistory(700));
  const remote = tab();
  await remote.start();
  await settled(remote);
  const lease = remote.thread(script.threadId);
  await vi.waitFor(() => expect(lease.store.thread).toBeDefined());
  remote.show(false);
  await pause(20);
  script.runUntilBlocked();
  const reference = (await inProcess(daemon)).thread(script.threadId);
  await vi.waitFor(() => expect(reference.store.order.length).toBeGreaterThan(100));
  remote.show(true);
  await vi.waitFor(() => {
    expect(transcript(lease.store)).toEqual(transcript(reference.store));
    expect(lease.store.agentIds()).toEqual(reference.store.agentIds());
  });
  lease.release();
  reference.release();
});

test("a tab remembers only its newest sent commands that nobody watches", async () => {
  const { daemon, tab } = world();
  const script = new ScenarioPlayer(daemon, longHistory(1));
  script.runUntilBlocked();
  const remote = tab("local", { unwatchedIntents: 2 });
  await remote.start();
  await settled(remote);
  const send = (text: string) =>
    remote.enqueue({
      type: "thread.send",
      threadId: ThreadId.parse(script.threadId),
      input: [{ type: "text", text }],
      delivery: "queue",
    });
  const first = await send("one");
  await send("two");
  const last = await send("three");
  expect(remote.intent(first).getSnapshot()).toBeUndefined();
  expect(remote.intent(last).getSnapshot()).toBeDefined();
});

test("a view over the whole thread list follows every entry through one key, and deleted threads leave it", async () => {
  const { daemon, tab } = world();
  const remote = tab();
  await remote.start();
  await settled(remote);
  const lease = remote.threads();
  const titles = lease.store.select(["threads"], (reader) =>
    reader.ids.map((id) => reader.thread(id)?.title),
  );
  let heard = 0;
  const stop = titles.subscribe(() => heard++);
  daemon.createThread({ id: "relay", workspaceId: "acme", title: "Relay", provider: "codex" });
  daemon.createThread({ id: "cache", workspaceId: "acme", title: "Cache", provider: "codex" });
  await vi.waitFor(() => expect(titles.getSnapshot()).toEqual(["Relay", "Cache"]));
  expect(heard).toBeGreaterThan(0);
  const deleted = await remote.command({
    type: "thread.delete",
    threadId: ThreadId.parse("relay"),
  });
  expect(deleted).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(lease.store.ids).toEqual(["cache"]));
  expect(titles.getSnapshot()).toEqual(["Cache"]);
  stop();
  lease.release();
});
import { createHash } from "node:crypto";
import { WorkspaceId, type HistoryOperationProgress } from "@ace/protocol";

test("one tab leaving preview or closing keeps the other tab's browser subscription alive", async () => {
  const { daemon, tab } = world();
  daemon.createThread({
    id: "preview",
    workspaceId: "project",
    title: "Preview",
    provider: "codex",
  });
  const threadId = ThreadId.parse("preview");
  const workspaceId = WorkspaceId.parse("project");
  const first = tab(),
    second = tab();
  await Promise.all([first.start(), second.start()]);
  await Promise.all([settled(first), settled(second)]);
  const urls: string[] = [];
  second.onMessage((message) => {
    if (message.type === "browser.state") urls.push(message.state.url);
  });
  await first.request({ type: "browser.open", options: { threadId, workspaceId } });
  await first.request({ type: "browser.subscribe", threadId });
  await second.request({ type: "browser.subscribe", threadId });
  await first.request({ type: "browser.unsubscribe", threadId });
  await second.request({
    type: "browser.execute",
    threadId,
    command: { action: "navigate", url: "https://example.org/after-leaving" },
  });
  await vi.waitFor(() => expect(urls).toContain("https://example.org/after-leaving"));
  await first.request({ type: "browser.subscribe", threadId });
  await first.close();
  await second.request({
    type: "browser.execute",
    threadId,
    command: { action: "navigate", url: "https://example.org/after-closing" },
  });
  await vi.waitFor(() => expect(urls).toContain("https://example.org/after-closing"));
  await second.request({ type: "browser.unsubscribe", threadId });
});

test("shared-worker file transfers preserve binary bytes, backpressure and workspace isolation", async () => {
  const { daemon, tab, faults } = world();
  daemon.createThread({ id: "files", workspaceId: "project", title: "Files", provider: "codex" });
  daemon.createThread({
    id: "other-files",
    workspaceId: "other",
    title: "Other",
    provider: "codex",
  });
  const remote = tab();
  await remote.start();
  await settled(remote);
  const bytes = Uint8Array.from({ length: 150000 }, (_, index) => index % 256);
  const threadId = ThreadId.parse("files");
  let produced = 0;
  async function* source() {
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      produced++;
      yield bytes.subarray(offset, offset + 65536);
    }
  }
  let releaseAck = noop;
  faults.incoming = (message, text, deliver) => {
    if (message.type === "files.upload" && message.offset === 65536)
      releaseAck = () => deliver(text);
    else deliver(text);
  };
  const uploading = remote.uploadFile(
    {
      threadId,
      path: "binary.dat",
      expected: null,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    source(),
  );
  await faults.wait((message) => message.type === "files.upload" && message.offset === 65536);
  // A port barrier lets any incorrectly eager source pull run while the ACK is withheld.
  await remote.request({ type: "diagnostics.health" });
  expect(produced).toBe(1);
  releaseAck();
  await uploading;
  expect(produced).toBe(3);
  const chunks: Uint8Array[] = [];
  for await (const chunk of remote.downloadFile({
    threadId,
    op: "download",
    path: "binary.dat",
    offset: 0,
  })) {
    expect(chunk.length).toBeLessThanOrEqual(65536);
    chunks.push(chunk);
  }
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
  await expect(
    remote
      .downloadFile({
        threadId: ThreadId.parse("other-files"),
        op: "download",
        path: "binary.dat",
        offset: 0,
      })
      .next(),
  ).rejects.toMatchObject({ code: "daemon" });
});

test("a tab lists draft commands without a thread and observes correlated history progress before completion", async () => {
  const { daemon, tab, faults } = world();
  const remote = tab();
  await remote.start();
  await settled(remote);
  const workspaceId = WorkspaceId.parse("project");
  const draft = await remote.request({
    type: "context.request",
    operation: { op: "draft.create", workspaceId },
  });
  if (draft.result.kind !== "draft") throw new Error("Draft missing");
  const commands = await remote.request({
    type: "commands.list",
    draft: { draftId: draft.result.draftId, workspaceId, provider: "codex" },
  });
  expect(commands.commands.length).toBeGreaterThan(0);
  expect(commands.commands.every((command) => command.scope !== "runtime")).toBe(true);
  expect(daemon.snapshot({ kind: "threads" })).toMatchObject({ threads: {} });
  const progress: HistoryOperationProgress[] = [];
  remote.onMessage((message) => {
    if (message.type === "history.operation.progress") progress.push(message);
  });
  let releaseTerminal = noop;
  faults.incoming = (message, text, deliver) => {
    if (message.type === "history.import") releaseTerminal = () => deliver(text);
    else deliver(text);
  };
  let completed = false;
  const importing = remote
    .request(
      { type: "history.import", sourceId: "missing", workspaceId },
      { requestId: "import-from-tab" },
    )
    .then((result) => {
      completed = true;
      return result;
    });
  await faults.wait((message) => message.type === "history.import");
  await remote.request({ type: "diagnostics.health" });
  expect(progress.map((event) => [event.requestId, event.phase])).toEqual([
    ["import-from-tab", "preparing"],
    ["import-from-tab", "unsupported"],
  ]);
  expect(completed).toBe(false);
  releaseTerminal();
  const result = await importing;
  expect(result).toMatchObject({
    type: "history.import",
    requestId: "import-from-tab",
    status: "unsupported",
  });
  await vi.waitFor(() =>
    expect(progress.map((event) => [event.requestId, event.phase])).toEqual([
      ["import-from-tab", "preparing"],
      ["import-from-tab", "unsupported"],
    ]),
  );
  const bound = await remote.request({
    type: "registry.bind",
    acpAgentId: "local:fixture",
    installationId: "fixture-install",
    instanceId: "fixture-instance",
    version: "1",
    command: "fake-acp",
    args: ["--stdio"],
  });
  expect(bound.result).toMatchObject({
    ok: true,
    installation: { installationId: "fixture-install", profileRevision: "generic-v1" },
  });
});

test("reconnect invalidates one tab's old file controls and detachment cannot cancel a reused channel in another tab", async () => {
  const { daemon, tab, faults } = world();
  daemon.createThread({
    id: "reconnect-files",
    workspaceId: "project",
    title: "Files",
    provider: "codex",
  });
  const threadId = ThreadId.parse("reconnect-files");
  const a = tab(),
    b = tab();
  await Promise.all([a.start(), b.start()]);
  await Promise.all([settled(a), settled(b)]);
  const bytes = Buffer.alloc(90000, 11);
  await a.uploadFile(
    {
      threadId,
      path: "data",
      expected: null,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    (async function* () {
      yield bytes.subarray(0, 65536);
      yield bytes.subarray(65536);
    })(),
  );
  const stale = a.downloadFile({ threadId, op: "download", path: "data", offset: 0 });
  expect((await stale.next()).value?.length).toBe(65536);
  daemon.disconnectAll();
  await vi.waitFor(() => {
    expect(a.state).not.toBe("ready");
    expect(b.state).not.toBe("ready");
  });
  await a.networkOnline(false);
  await a.networkOnline(true);
  await Promise.all([settled(a), settled(b)]);
  const old = await faults.wait((message) => message.type === "files.ready");
  const discarded = await b.request({
    type: "files.request",
    threadId,
    operation: { op: "download", path: "data", offset: 0 },
  });
  if (discarded.type !== "files.ready") throw new Error("Missing discarded transfer");
  b.send({ type: "files.cancel", channel: discarded.channel });
  const reopened = await b.request({
    type: "files.request",
    threadId,
    operation: { op: "download", path: "data", offset: 0 },
  });
  if (reopened.type !== "files.ready" || old.type !== "files.ready")
    throw new Error("Missing reopened transfer");
  expect(reopened.channel).toBe(old.channel);
  await expect(stale.next()).rejects.toMatchObject({ code: "offline" });
  await expect(a.request({ type: "files.pull", channel: reopened.channel })).rejects.toMatchObject({
    code: "offline",
  });
  a.send({ type: "files.cancel", channel: reopened.channel });
  await a.close();
  await a.left;
  await b.request({ type: "diagnostics.health" });
  expect(await b.request({ type: "files.pull", channel: reopened.channel })).toMatchObject({
    type: "files.data",
    offset: 0,
    eof: false,
  });
});

test("failed Preview reservations do not prevent a ninth valid subscription", async () => {
  const { daemon, tab, faults } = world();
  const remote = tab();
  await remote.start();
  await settled(remote);
  for (let i = 0; i < 8; i++) {
    if (i === 4)
      faults.incoming = (message, text, deliver) => {
        if (message.type === "error" && message.requestId)
          deliver(
            JSON.stringify({
              type: "browser.result",
              requestId: message.requestId,
              ok: false,
              error: "Browser unavailable",
            }),
          );
        else deliver(text);
      };
    const request = remote.request({
      type: "browser.subscribe",
      threadId: ThreadId.parse(`missing-${i}`),
    });
    if (i < 4) await expect(request).rejects.toMatchObject({ code: "daemon" });
    else expect(await request).toMatchObject({ ok: false });
  }
  daemon.createThread({
    id: "available",
    workspaceId: "project",
    title: "Available",
    provider: "codex",
  });
  const threadId = ThreadId.parse("available");
  await remote.request({
    type: "browser.open",
    options: { threadId, workspaceId: WorkspaceId.parse("project") },
  });
  expect(await remote.request({ type: "browser.subscribe", threadId })).toMatchObject({ ok: true });
});

test("Preview transitions wait for the previous receipt and preserve newer detach cleanup", async () => {
  const { daemon, tab, faults } = world();
  daemon.createThread({
    id: "racing-preview",
    workspaceId: "project",
    title: "Preview",
    provider: "codex",
  });
  const threadId = ThreadId.parse("racing-preview"),
    workspaceId = WorkspaceId.parse("project");
  const a = tab(),
    b = tab();
  await Promise.all([a.start(), b.start()]);
  await Promise.all([settled(a), settled(b)]);
  await a.request({ type: "browser.open", options: { threadId, workspaceId } });
  await a.request({ type: "browser.subscribe", threadId });
  let release = noop;
  faults.incoming = (message, text, deliver) => {
    if (message.type === "browser.result" && message.requestId === "leaving")
      release = () => deliver(text);
    else deliver(text);
  };
  const leaving = a.request({ type: "browser.unsubscribe", threadId }, { requestId: "leaving" });
  await faults.wait(
    (message) => message.type === "browser.result" && message.requestId === "leaving",
  );
  let returned = false;
  const returning = a
    .request({ type: "browser.subscribe", threadId }, { requestId: "returning" })
    .then((value) => {
      returned = true;
      return value;
    });
  // An ordered request/reply on the same port drains any incorrectly concurrent reply.
  await a.request({ type: "diagnostics.health" });
  expect(returned).toBe(false);
  release();
  await Promise.all([leaving, returning]);
  const states: string[] = [];
  b.onMessage((message) => {
    if (message.type === "browser.state") states.push(message.state.url);
  });
  await a.close();
  await a.left;
  await b.request({ type: "diagnostics.health" });
  await b.request({
    type: "browser.execute",
    threadId,
    command: { action: "navigate", url: "https://example.org/unsubscribed" },
  });
  await b.request({ type: "diagnostics.health" });
  expect(states).not.toContain("https://example.org/unsubscribed");
});

function noop() {}

test("worker project APIs forward create add rename remove folder reads and project pushes", async () => {
  const f = world();
  const a = f.tab();
  const b = f.tab();
  await a.start();
  await b.start();
  const changed = Promise.withResolvers<void>();
  const changes: string[] = [];
  b.projects.onChanged((change) => {
    changes.push(change.change);
    if (change.change === "removed") changed.resolve();
  });
  await b.projects.home();
  const added = await a.projects.create({ parent: "/fake", name: "empty" });
  expect(added).toMatchObject({ ok: true, workspace: { name: "empty", path: "/fake/empty" } });
  if (!added.workspace) throw new Error("Expected created project");
  expect(await a.projects.add({ path: "/fake/empty" })).toMatchObject({
    workspace: { id: added.workspace.id },
  });
  expect(
    await b.request({ type: "workspace.request", operation: { op: "workspaces.list" } }),
  ).toMatchObject({ result: { kind: "workspaces", workspaces: [{ id: added.workspace.id }] } });
  expect(
    await a.projects.rename({ workspaceId: added.workspace.id, name: "Renamed" }),
  ).toMatchObject({ ok: true });
  expect(await b.projects.home()).toMatchObject({ result: { kind: "home", path: "/fake" } });
  expect(await b.projects.browse({ path: "/fake" })).toMatchObject({
    result: { kind: "directories", entries: [{ name: "empty" }] },
  });
  expect(await b.projects.inspect("/fake/empty")).toMatchObject({
    result: { kind: "inspection", git: null },
  });
  expect(await b.projects.recentFolders()).toMatchObject({
    result: { kind: "recentFolders", folders: [{ name: "Renamed" }] },
  });
  expect(await a.projects.remove({ workspaceId: added.workspace.id })).toMatchObject({ ok: true });
  await changed.promise;
  expect(changes).toEqual(["added", "renamed", "removed"]);
  expect(
    await b.request({ type: "workspace.request", operation: { op: "workspaces.list" } }),
  ).toMatchObject({ result: { workspaces: [] } });
});

test("worker clone progress arrives before completion and cancellation returns a failed clone receipt", async () => {
  const stages: (() => void)[] = [];
  const f = world(undefined, {}, (callback) => stages.push(callback));
  const client = f.tab();
  await client.start();
  const starting = Promise.withResolvers<string>();
  const stop = client.projects.onCloneProgress((progress) => {
    if (progress.phase === "starting") starting.resolve(progress.commandId);
  });
  const clone = client.projects.clone(
    { parent: "/fake", name: "cancelled", url: "https://example.com/project.git" },
    {},
    "clone-cancel",
  );
  const id = await starting.promise;
  expect(await client.projects.cancelClone(id)).toMatchObject({
    result: { kind: "cancelled", commandId: id },
  });
  expect(await clone).toMatchObject({ ok: false, error: "clone_cancelled" });
  expect(await client.projects.recentFolders()).toMatchObject({ result: { folders: [] } });
  stop();
});
