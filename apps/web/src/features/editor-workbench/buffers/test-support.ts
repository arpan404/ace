import { lineChanges, merge3 } from "@ace/editor";
import { initEditorForTests } from "@/features/editor/test-support.ts";
import type { BufferKey, DiskFile, Draft, DraftStore, FilePort, MergePort } from "./types.ts";

/*
 * Fakes for what the registry cannot control: a checkout on "disk" that an agent can write
 * behind the editor's back, device storage for drafts that outlives a registry (a reload), and
 * time. The Wasm document and merge are the real ones.
 */

export const ready = initEditorForTests;

const id = (key: BufferKey) => `${key.root}\u0000${key.path}`;

export function fakeDisk(files: Record<string, string> = {}, root = "m1/t1") {
  let next = 0;
  const stored = new Map<string, { text: string; version: string }>();
  const put = (path: string, text: string) => {
    next += 1;
    stored.set(id({ root, path }), { text, version: `v${next}` });
  };
  for (const [path, text] of Object.entries(files)) put(path, text);
  let offline = false;
  let writeGate: Promise<void> | undefined;
  const port: FilePort = {
    async read(key) {
      if (offline) throw new Error("The daemon is offline.");
      const file = stored.get(id(key));
      return file ? { kind: "text", ...file } : ({ kind: "missing" } satisfies DiskFile);
    },
    async write(key, text, expected) {
      if (writeGate) await writeGate;
      if (offline) throw new Error("The daemon is offline.");
      const file = stored.get(id(key));
      if ((file?.version ?? null) !== expected) return { kind: "clash" };
      put(key.path, text);
      return { kind: "saved", version: stored.get(id(key))?.version ?? "" };
    },
  };
  return {
    port,
    /** Someone else (an agent) writes the file. */
    write: put,
    remove(path: string) {
      stored.delete(id({ root, path }));
    },
    text: (path: string) => stored.get(id({ root, path }))?.text,
    version: (path: string) => stored.get(id({ root, path }))?.version,
    setOffline(value: boolean) {
      offline = value;
    },
    /** Writes wait until the returned function runs (a slow save). */
    holdWrites(): () => void {
      const gate = Promise.withResolvers<void>();
      writeGate = gate.promise;
      return () => {
        writeGate = undefined;
        gate.resolve();
      };
    },
  };
}

/**
 * Device storage: pass the same one to a second registry to simulate a reload. Like IndexedDB,
 * writes and deletes take effect in the order they are called, also while `hold` delays them.
 */
export function memoryDrafts() {
  const stored = new Map<string, { key: BufferKey; draft: Draft }>();
  let full = false;
  let held: (() => void)[] | undefined;
  /** Applies `change` now, or in call order once released. */
  const run = (change: () => void) =>
    new Promise<void>((resolve, reject) => {
      const apply = () => {
        try {
          change();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      if (held) held.push(apply);
      else apply();
    });
  const store: DraftStore = {
    async get(key) {
      return stored.get(id(key))?.draft;
    },
    put: (key, draft) =>
      run(() => {
        if (full) throw new Error("QuotaExceededError");
        stored.set(id(key), { key, draft: { ...draft } });
      }),
    delete: (key) => run(() => void stored.delete(id(key))),
    async list(root) {
      return [...stored.values()]
        .filter((entry) => entry.key.root === root)
        .map((entry) => ({ path: entry.key.path, draft: entry.draft }));
    },
  };
  return {
    store,
    setFull(value: boolean) {
      full = value;
    },
    /** The stored draft's text right now, without waiting. */
    peek: (key: BufferKey) => stored.get(id(key))?.draft.text,
    /** Writes wait (in order) until the returned function runs: a slow device. */
    hold(): () => void {
      held = [];
      return () => {
        const waiting = held ?? [];
        held = undefined;
        for (const apply of waiting) apply();
      };
    },
  };
}

/** A clock and timers that move only when the test says so. */
export function manualTime(start = 1_000) {
  let now = start;
  let timers: { at: number; run: () => void }[] = [];
  return {
    now: () => now,
    schedule(run: () => void, ms: number) {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => {
        timers = timers.filter((other) => other !== timer);
      };
    },
    /** Moves time forward, running each timer that falls due, then lets promises settle. */
    async advance(ms: number) {
      now += ms;
      const due = timers.filter((timer) => timer.at <= now);
      timers = timers.filter((timer) => timer.at > now);
      for (const timer of due) timer.run();
      await settle();
    },
  };
}

/** Lets pending promise chains (fake I/O) finish. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 20; round++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The real merge, in place; `hold` makes the next merge wait until released. */
export function inlineMerge() {
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  const port: MergePort = {
    async merge3(base, mine, theirs) {
      if (gate) await gate;
      return merge3(base, mine, theirs);
    },
    async lineChanges(before, after) {
      return lineChanges(before, after);
    },
  };
  return {
    port,
    hold() {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = undefined;
      open?.();
    },
  };
}
