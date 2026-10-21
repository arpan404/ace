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
  releaseHeld: () => void;
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
  return {
    client,
    transcript: new NativeTranscript(client),
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

function readOlder(transcript: NativeTranscript) {
  return transcript.read(
    { type: "native.transcript", threadId: THREAD, operation: "older" },
    new AbortController().signal,
  );
}

async function olderPagesTask(): Promise<Record<string, unknown>> {
  const fixture = await setupFixture();
  try {
    await fixture.transcript.read(
      { type: "native.transcript", threadId: THREAD, operation: "hold" },
      new AbortController().signal,
    );
    const counts: number[] = [];
    const firstSeqs: number[] = [];
    let withinPageDupes = 0;
    let overlapConsistent = true;
    let prependedAreOlder = true;
    let allSequenced = true;
    let reachedStart = false;
    let prev: { ids: string[]; seqOf: Map<string, number> } | undefined;
    for (let page = 0; page < 30; page++) {
      const result = await readOlder(fixture.transcript);
      const ids = result.items.map((item) => String((item as { id: string }).id));
      const seqs = result.items.map((item) => (item as { seq?: unknown }).seq);
      counts.push(ids.length);
      if (seqs.some((seq) => typeof seq !== "number")) allSequenced = false;
      // Reading windows overlap by construction (older pages prepend), so correctness is
      // the overlap: shared items keep order and sequence, and only older items are new.
      const seqOf = new Map<string, number>();
      const pos = new Map<string, number>();
      ids.forEach((id, index) => {
        if (typeof seqs[index] === "number" && !seqOf.has(id)) seqOf.set(id, seqs[index] as number);
        if (!pos.has(id)) pos.set(id, index);
      });
      const firstId = ids[0];
      const firstSeq = firstId === undefined ? undefined : seqOf.get(firstId);
      if (typeof firstSeq === "number") firstSeqs.push(firstSeq);
      withinPageDupes += ids.length - pos.size;
      if (prev !== undefined) {
        const prevFirstId = prev.ids[0];
        const prevFirst = prevFirstId === undefined ? undefined : prev.seqOf.get(prevFirstId);
        const common = prev.ids.filter((id) => seqOf.has(id));
        if (common.length === 0) overlapConsistent = false;
        let lastIndex = -1;
        for (const id of common) {
          const index = pos.get(id) as number;
          if (index <= lastIndex || seqOf.get(id) !== prev.seqOf.get(id)) {
            overlapConsistent = false;
            break;
          }
          lastIndex = index;
        }
        if (typeof prevFirst === "number") {
          for (const id of ids) {
            if (prev.seqOf.has(id)) continue;
            const seq = seqOf.get(id);
            if (typeof seq !== "number" || seq >= prevFirst) {
              prependedAreOlder = false;
              break;
            }
          }
        }
      }
      prev = { ids, seqOf };
      if (!result.hasOlder) {
        reachedStart = true;
        break;
      }
    }
    return {
      pages: counts.length,
      counts,
      firstSeqs,
      withinPageDupes,
      overlapConsistent,
      prependedAreOlder,
      allSequenced,
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
        { type: "native.transcript", threadId: THREAD, operation: "hold" },
        new AbortController().signal,
      );
      for (let page = 0; page < 3; page++) await readOlder(fixture.transcript);
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
      { type: "native.transcript", threadId: THREAD, operation: "hold" },
      new AbortController().signal,
    );
    let maxItems = 0;
    let pages = 0;
    let reachedStart = false;
    for (; pages < 30; pages++) {
      const result = await readOlder(fixture.transcript);
      maxItems = Math.max(maxItems, result.items.length);
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
      { type: "native.transcript", threadId: THREAD, operation: "hold" },
      new AbortController().signal,
    );
    holdArmed = true;
    const interrupted = new AbortController();
    const first = fixture.transcript.read(
      { type: "native.transcript", threadId: THREAD, operation: "older" },
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
    const retried = await readOlder(fixture.transcript);
    fixture.releaseHeld();
    await settleMicrotasks();
    return {
      held,
      cancelled,
      retriedActive: retried.active,
      retriedItems: retried.items.length,
      retriedHasOlder: retried.hasOlder,
    };
  } finally {
    await teardownFixture(fixture);
  }
}
