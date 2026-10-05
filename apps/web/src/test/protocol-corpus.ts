import { Client, type Transport } from "@ace/client";
import {
  FakeDaemon,
  ScenarioPlayer,
  devWorld,
  fakeTransport,
  hostFolders,
  seedPanels,
  workbenchServices,
} from "@ace/fake-daemon";
import { DeviceId, ThreadId } from "@ace/protocol";

/*
 * Real protocol traffic for tests that check two builds of the schemas agree: the fake daemon
 * seeded the way `vite --mode fake` seeds it (every dev-world thread, the panels' services,
 * decks, automations, plugins, accounts), and a real `Client` subscribing to every thread and
 * making the service reads the app makes. Every frame each side sends is recorded as JSON.
 */

export interface ProtocolCorpus {
  /** Frames the daemon sent: welcome, snapshots, events, replies, errors. */
  server: unknown[];
  /** Frames the client sent, after its own decoding (defaults filled in). */
  client: unknown[];
}

const now = Date.parse("2026-10-04T12:00:00Z");

function recording(daemon: FakeDaemon, corpus: ProtocolCorpus): Transport {
  const inner = fakeTransport(daemon);
  return {
    open(events) {
      inner.open({
        ...events,
        message(text) {
          corpus.server.push(JSON.parse(text));
          events.message(text);
        },
      });
    },
    send(text) {
      corpus.client.push(JSON.parse(text));
      inner.send(text);
    },
    close: () => inner.close(),
  };
}

/** Lets every queued microtask and timer of the fake transport run. */
async function settle(corpus: ProtocolCorpus): Promise<void> {
  let seen = -1;
  while (seen !== corpus.server.length + corpus.client.length) {
    seen = corpus.server.length + corpus.client.length;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export async function protocolCorpus(): Promise<ProtocolCorpus> {
  const corpus: ProtocolCorpus = { server: [], client: [] };
  let tick = now;
  const daemon = new FakeDaemon({ clock: () => (tick += 1), snapshotItems: 40 });
  const world = devWorld();
  for (const thread of world) {
    const player = new ScenarioPlayer(daemon, thread.scenario, { agoMs: thread.agoMs });
    if (thread.through) player.runThrough(thread.through);
    else player.runUntilBlocked();
  }
  const host = hostFolders(now);
  daemon.projects.seedFolders(host.home, host.folders);
  seedPanels(daemon);
  daemon.seedServices(workbenchServices(now, "UTC"));

  let ids = 0;
  const client = new Client({
    deviceId: DeviceId.parse("corpus-device"),
    transport: () => recording(daemon, corpus),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `corpus-${++ids}`,
  });
  await client.start();
  await settle(corpus);

  const sidebar = client.threads();
  const threadIds = world.map((thread) => thread.scenario.thread.id);
  await settle(corpus);

  // Replies and errors alike are part of the corpus.
  const attempt = async (read: () => Promise<unknown>) => {
    await read().catch(() => undefined);
    await settle(corpus);
  };
  await attempt(() => client.request({ type: "diagnostics.health" }));
  await attempt(() => client.request({ type: "accounts.list" }));
  await attempt(() => client.request({ type: "automation.list" }));
  await attempt(() => client.request({ type: "automation.inbox", limit: 20 }));
  await attempt(() => client.request({ type: "models.list" }));
  await attempt(() => client.request({ type: "providers.request", operation: "list" }));
  await attempt(() => client.request({ type: "projects.request", operation: { op: "fs.home" } }));
  await attempt(() => client.settingsGet("threads.autoSettleAfter"));
  await attempt(() => client.settingsGet("providers.default"));
  await attempt(() =>
    client.request({ type: "usage.summary", query: { from: "2026-10-01", to: "2026-10-04" } }),
  );
  // One thread at a time: the client holds a bounded number of thread stores.
  for (const threadId of threadIds) {
    const lease = client.thread(threadId);
    await settle(corpus);
    await attempt(() => client.queue(threadId));
    await attempt(() => client.itemsPage({ threadId, limit: 50 }));
    await attempt(() => client.turnsPage({ threadId }));
    await attempt(() => client.itemsWindow({ threadId, turnOrdinal: 1 }));
    await attempt(() => client.threadSearch({ threadId, text: "the" }));
    await attempt(() => client.threadReadState({ threadId }));
    lease.release();
  }
  const first = threadIds[0] && ThreadId.parse(threadIds[0]);
  if (first) {
    await attempt(() =>
      client.command({ type: "thread.interrupt", threadId: first, cascade: true }),
    );
    await attempt(() => client.command({ type: "thread.archive", threadId: first }));
  }

  sidebar.release();
  await client.close();
  return corpus;
}
