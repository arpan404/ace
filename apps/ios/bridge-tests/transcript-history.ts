import { ClientCore } from "@ace/client";
import { FakeDaemon, ScenarioPlayer, fakeTransport, multiDayDemo } from "@ace/fake-daemon";
import { DeviceId, ThreadId } from "@ace/protocol";
import { host } from "../bridge/polyfills.ts";
import { NativeTranscript } from "../bridge/native-transcript.ts";

/**
 * Bounded history regression tests for NativeTranscript (ADR 0062), through the real public
 * ClientCore and FakeDaemon over a controlled in-memory transport. Test-only: loaded by
 * bridge-tests/delivery.ts, driven from TranscriptHistoryBridgeTests.swift. No production
 * shipping hooks, no timers beyond the harness virtual scheduler.
 */

const THREAD_ID = "thread-history";
const THREAD = ThreadId.parse(THREAD_ID);
/** History window bound the native transcript must stay within while paging older. */
const WINDOW_ITEM_BOUND = 2200;

export function installHistoryScenarios(): void {
  if (typeof globalThis.setTimeout !== "function") {
    Object.assign(globalThis, {
      setTimeout: (callback: () => void, delay = 0): string => {
        const id = host.uuid();
        host.timer(id, delay, callback);
        return id;
      },
      clearTimeout: (id: string): void => host.cancelTimer(id),
    });
  }
  if (typeof globalThis.structuredClone !== "function") {
    // Test-only fallback for older JavaScriptCore without structuredClone. Production
    // polyfills.ts is untouched. FakeDaemon and the client only clone plain protocol data
    // (items, summaries, capabilities, lists), where a JSON round-trip is equivalent.
    Object.assign(globalThis, {
      structuredClone: (value: unknown): unknown => JSON.parse(JSON.stringify(value)),
    });
  }
  Object.assign(globalThis, {
    transcriptHistoryOlderPages: () => runScenario("older-pages", olderPagesTask),
    transcriptHistoryLiveTail: () => runScenario("live-tail", liveTailTask),
    transcriptHistoryWindowBound: () => runScenario("window-bound", windowBoundTask),
    transcriptHistoryCancelRetry: () => runScenario("cancel-retry", cancelRetryTask),
    transcriptHistorySnapshot: (name: string): string =>
      JSON.stringify(snapshots[name] ?? { settled: false, ok: false, detail: {} }),
  });
}

interface HistorySnapshot {
  settled: boolean;
  ok: boolean;
  detail: Record<string, unknown>;
}

const snapshots: Record<string, HistorySnapshot> = {};

function runScenario(name: string, task: () => Promise<Record<string, unknown>>): void {
  snapshots[name] = { settled: false, ok: false, detail: {} };
  task().then(
    (detail) => {
      snapshots[name] = { settled: true, ok: true, detail };
    },
    (error) => {
      snapshots[name] = {
        settled: true,
        ok: false,
        detail: { error: error instanceof Error ? error.message : String(error) },
      };
    },
  );
}

type InnerTransport = ReturnType<typeof fakeTransport>;

let holdArmed = false;
let heldRequest: string | undefined;

function isWindowRequest(text: string): boolean {
  try {
    return (JSON.parse(text) as { type?: unknown } | null)?.type === "items.window";
  } catch {
    return false;
  }
}

function wrapTransport(inner: InnerTransport): InnerTransport {
  return {
    open: (events) => inner.open(events),
    send: (text) => {
      if (holdArmed && heldRequest === undefined && isWindowRequest(text)) {
        holdArmed = false;
        heldRequest = text;
        return;
      }
      inner.send(text);
    },
    close: () => inner.close(),
  };
}

interface Fixture {
  client: ClientCore;
  transcript: NativeTranscript;
  /** The reading rows Swift would hold, in the order it shows them. */
  rows: () => string[];
  releaseHeld: () => void;
}

/** A sink that applies each reading patch at once, as Swift's copy of the window. */
function readingSink() {
  const positions = new Map<string, number>();
  const sink = {
    put(key: string, read: () => Record<string, unknown> | undefined) {
      if (!key.startsWith("reading:")) return;
      const patch = read();
      if (!patch) return;
      if (patch.type === "thread.reset") positions.clear();
      if (patch.type === "thread.position" && typeof patch.id === "string")
        positions.set(patch.id, Number(patch.index));
      if (patch.type !== "thread.item" || typeof patch.id !== "string") return;
      const row = patch.row as { index?: number } | null;
      if (!row) positions.delete(patch.id);
      else positions.set(patch.id, row.index ?? positions.get(patch.id) ?? 0);
    },
    clear(prefix: string) {
      if (prefix === "reading:") positions.clear();
    },
  };
  const rows = () => [...positions].toSorted((a, b) => a[1] - b[1]).map(([id]) => id);
  return { sink, rows };
}

async function settleMicrotasks(rounds = 200): Promise<void> {
  for (let round = 0; round < rounds; round++) await Promise.resolve();
}

async function waitFor(ready: () => boolean, rounds = 500): Promise<boolean> {
  for (let round = 0; round < rounds && !ready(); round++) await Promise.resolve();
  return ready();
}

async function setupFixture(): Promise<Fixture> {
  holdArmed = false;
  heldRequest = undefined;
  const daemon = new FakeDaemon({ clock: () => host.now() });
  new ScenarioPlayer(daemon, multiDayDemo(THREAD_ID, 12, { scans: 200 })).runUntilBlocked();
  const inner = fakeTransport(daemon);
  let nextId = 0;
  const client = new ClientCore({
    deviceId: DeviceId.parse("phone"),
    transport: () => wrapTransport(inner),
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const id = host.uuid();
        host.timer(id, delay, callback);
        return () => host.cancelTimer(id);
      },
    },
    random: () => 0,
    id: () => `phone-${++nextId}`,
    now: () => host.now(),
  });
  await client.start();
  const ready = await waitFor(() => client.state === "ready");
  if (!ready) throw new Error("Client did not reach ready.");
  // A hold before the subscription snapshot arrives would read an empty tail, so every
  // scenario starts only once the leased store is populated.
  const probe = client.thread(THREAD_ID);
  try {
    const populated = await waitFor(() => probe.store.order.length > 0);
    if (!populated) throw new Error("Thread store never populated.");
  } finally {
    probe.release();
  }
  const reading = readingSink();
  return {
    client,
    transcript: new NativeTranscript(client, reading.sink),
    rows: reading.rows,
    releaseHeld: () => {
      const text = heldRequest;
      heldRequest = undefined;
      if (text !== undefined) inner.send(text);
    },
  };
}

async function teardownFixture(fixture: Fixture): Promise<void> {
  fixture.transcript.close();
  await fixture.client.close();
}

function readOlder(fixture: Fixture) {
  return fixture.transcript.read(
    { type: "native.transcript", threadId: THREAD, epoch: -1, operation: "older" },
    new AbortController().signal,
  );
}

async function olderPagesTask(): Promise<Record<string, unknown>> {
  const fixture = await setupFixture();
  try {
    await fixture.transcript.read(
      { type: "native.transcript", threadId: THREAD, epoch: -1, operation: "hold" },
      new AbortController().signal,
    );
    const counts: number[] = [];
    let withinPageDupes = 0;
    let overlapConsistent = true;
    let prependedAreOlder = true;
    let firstMoved = true;
    let reachedStart = false;
    let prev: string[] | undefined;
    for (let page = 0; page < 30; page++) {
      const result = await readOlder(fixture);
      const ids = fixture.rows();
      counts.push(ids.length);
      const pos = new Map<string, number>();
      ids.forEach((id, index) => {
        if (!pos.has(id)) pos.set(id, index);
      });
      withinPageDupes += ids.length - pos.size;
      if (prev !== undefined) {
        // Successive windows overlap (older pages prepend): shared rows keep their order, and
        // every new row comes before them.
        const common = prev.filter((id) => pos.has(id));
        if (common.length === 0) overlapConsistent = false;
        let lastIndex = -1;
        for (const id of common) {
          const index = pos.get(id) ?? -1;
          if (index <= lastIndex) overlapConsistent = false;
          lastIndex = index;
        }
        const firstShared = pos.get(common[0] ?? "") ?? 0;
        const known = new Set(prev);
        if (ids.some((id, index) => !known.has(id) && index > firstShared))
          prependedAreOlder = false;
        if (ids[0] === prev[0] && result.hasOlder) firstMoved = false;
      }
      prev = ids;
      if (!result.hasOlder) {
        reachedStart = true;
        break;
      }
    }
    return {
      pages: counts.length,
      counts,
      withinPageDupes,
      overlapConsistent,
      prependedAreOlder,
      firstMoved,
      reachedStart,
    };
  } finally {
    await teardownFixture(fixture);
  }
}

async function liveTailTask(): Promise<Record<string, unknown>> {
  const fixture = await setupFixture();
  try {
    const observer = fixture.client.thread(THREAD_ID);
    try {
      const populated = await waitFor(() => observer.store.order.length > 0);
      if (!populated) throw new Error("Live tail never populated.");
      const tailBefore = observer.store.order.slice(-8);
      const lenBefore = observer.store.order.length;
      await fixture.transcript.read(
        { type: "native.transcript", threadId: THREAD, epoch: -1, operation: "hold" },
        new AbortController().signal,
      );
      for (let page = 0; page < 3; page++) await readOlder(fixture);
      const tailAfter = observer.store.order.slice(-8);
      const lenAfter = observer.store.order.length;
      return {
        tailBefore,
        tailAfter,
        tailSame: JSON.stringify(tailBefore) === JSON.stringify(tailAfter),
        lenBefore,
        lenAfter,
      };
    } finally {
      observer.release();
    }
  } finally {
    await teardownFixture(fixture);
  }
}

async function windowBoundTask(): Promise<Record<string, unknown>> {
  const fixture = await setupFixture();
  try {
    await fixture.transcript.read(
      { type: "native.transcript", threadId: THREAD, epoch: -1, operation: "hold" },
      new AbortController().signal,
    );
    let maxItems = 0;
    let pages = 0;
    let reachedStart = false;
    for (; pages < 30; pages++) {
      const result = await readOlder(fixture);
      maxItems = Math.max(maxItems, fixture.rows().length);
      if (!result.hasOlder) {
        reachedStart = true;
        pages++;
        break;
      }
    }
    return { pages, maxItems, bound: WINDOW_ITEM_BOUND, reachedStart };
  } finally {
    await teardownFixture(fixture);
  }
}

async function cancelRetryTask(): Promise<Record<string, unknown>> {
  const fixture = await setupFixture();
  try {
    await fixture.transcript.read(
      { type: "native.transcript", threadId: THREAD, epoch: -1, operation: "hold" },
      new AbortController().signal,
    );
    holdArmed = true;
    const interrupted = new AbortController();
    const first = fixture.transcript.read(
      { type: "native.transcript", threadId: THREAD, epoch: -1, operation: "older" },
      interrupted.signal,
    );
    const held = await waitFor(() => heldRequest !== undefined);
    interrupted.abort();
    let cancelled = false;
    try {
      await first;
    } catch (error) {
      cancelled = /cancel/i.test(error instanceof Error ? error.message : String(error));
    }
    const retried = await readOlder(fixture);
    fixture.releaseHeld();
    await settleMicrotasks();
    return {
      held,
      cancelled,
      retriedActive: retried.active,
      retriedItems: fixture.rows().length,
      retriedHasOlder: retried.hasOlder,
    };
  } finally {
    await teardownFixture(fixture);
  }
}
