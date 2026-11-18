import { expect, it } from "vitest";
import type { EventPayload } from "@ace/files-native";
import { ThreadId } from "@ace/protocol";
import { FolderWatch, type FolderWatchClient, type FoldersChanged } from "./folder-watch.ts";
import { TestClock } from "./test-clock.ts";

const main = ThreadId.parse("main");

class FakeWatch {
  readonly calls: { path: string; onBatch: (payload: EventPayload) => void }[] = [];
  readonly released: string[] = [];
  readonly failure: Error | undefined;
  /** When set, a starting watch waits for it before it counts as subscribed. */
  gate: Promise<void> | undefined;
  /** When set, releasing a subscription waits for it, so a close can be caught draining. */
  releaseGate: Promise<void> | undefined;

  constructor(failure?: Error) {
    this.failure = failure;
  }

  watch(path: string, onBatch: (payload: EventPayload) => void): Promise<() => Promise<void>> {
    if (this.failure) return Promise.reject(this.failure);
    this.calls.push({ path, onBatch });
    const opening = this.gate ?? Promise.resolve();
    return opening.then(() => async () => {
      if (this.releaseGate) await this.releaseGate;
      this.released.push(path);
    });
  }
}

type ClientOptions = { sendable?: () => boolean; valid?: () => boolean };

function client(
  id: string,
  inbox: FoldersChanged[],
  options: ClientOptions = {},
): FolderWatchClient {
  return {
    id,
    sendable: () => options.sendable?.() ?? true,
    valid: () => options.valid?.() ?? true,
    send: (message) => inbox.push(message),
  };
}

function changes(...paths: string[]): EventPayload {
  return {
    type: "changes",
    changes: paths.map((path) => ({ path, kind: "modified", directory: false })),
  };
}

function folders(...names: string[]): EventPayload {
  return {
    type: "changes",
    changes: names.map((path) => ({ path, kind: "created", directory: true })),
  };
}

function setup() {
  const clock = new TestClock();
  const port = new FakeWatch();
  const watch = new FolderWatch(port, { clock });
  return { clock, port, watch };
}

it("shares one watch of a checkout between every client", async () => {
  const { clock, port, watch } = setup();
  const phone: FoldersChanged[] = [];
  const browser: FoldersChanged[] = [];
  await watch.watch(client("phone", phone), main, "/w", ["src"]);
  await watch.watch(client("browser", browser), main, "/w", ["docs"]);
  expect(port.calls).toHaveLength(1);
  expect(port.calls[0]?.path).toBe("/w");
  port.calls[0]?.onBatch(changes("src/a.ts", "docs/b.md"));
  clock.advance(100);
  expect(phone).toMatchObject([{ type: "files.folders_changed", folders: ["src"], rescan: false }]);
  expect(browser).toMatchObject([
    { type: "files.folders_changed", folders: ["docs"], rescan: false },
  ]);
});

it("stops the shared watch with its last client", async () => {
  const { watch, port } = setup();
  await watch.watch(client("phone", []), main, "/w", ["src"]);
  await watch.watch(client("browser", []), main, "/w", ["docs"]);
  await watch.disconnect("phone");
  expect(port.released).toEqual([]);
  await watch.disconnect("browser");
  expect(port.released).toEqual(["/w"]);
});

it("a socket that closes while a watch starts releases that watch", async () => {
  const { watch, port } = setup();
  const gate = Promise.withResolvers<void>();
  port.gate = gate.promise;
  const opening = watch.watch(client("phone", []), main, "/w", ["src"]);
  // Let the queued watch pass its liveness check and start acquiring the root.
  await Promise.resolve();
  const closing = watch.disconnect("phone");
  gate.resolve();
  await opening;
  await closing;
  expect(port.released).toEqual(["/w"]);
});

it("a watch that arrives while the socket's close drains starts nothing", async () => {
  const { port, watch } = setup();
  const gate = Promise.withResolvers<void>();
  port.releaseGate = gate.promise;
  await watch.watch(client("phone", []), main, "/w", ["src"]);
  const closing = watch.disconnect("phone");
  await Promise.resolve();
  // The close is still releasing its checkout, so this late message finds the closed session.
  await watch.watch(client("phone", []), main, "/w2", ["src"]);
  gate.resolve();
  await closing;
  expect(port.calls.map((call) => call.path)).toEqual(["/w"]);
  expect(port.released).toEqual(["/w"]);
});

it("replaces a client's folders instead of adding to them", async () => {
  const { clock, port, watch } = setup();
  const inbox: FoldersChanged[] = [];
  const phone = client("phone", inbox);
  await watch.watch(phone, main, "/w", ["src"]);
  await watch.watch(phone, main, "/w", ["docs"]);
  port.calls[0]?.onBatch(changes("src/a.ts"));
  clock.advance(1_000);
  expect(inbox).toEqual([]);
  port.calls[0]?.onBatch(changes("docs/b.md"));
  clock.advance(100);
  expect(inbox).toMatchObject([{ folders: ["docs"] }]);
});

it("an empty folder list stops watching the thread", async () => {
  const { clock, port, watch } = setup();
  const inbox: FoldersChanged[] = [];
  const phone = client("phone", inbox);
  await watch.watch(phone, main, "/w", ["src"]);
  await watch.watch(phone, main, "/w", []);
  port.calls[0]?.onBatch(changes("src/a.ts"));
  clock.advance(1_000);
  expect(inbox).toEqual([]);
  expect(port.released).toEqual(["/w"]);
});

it("a socket that may no longer read stops quietly", async () => {
  const { clock, port, watch } = setup();
  const inbox: FoldersChanged[] = [];
  await watch.watch(client("phone", inbox, { sendable: () => false }), main, "/w", ["src"]);
  port.calls[0]?.onBatch(changes("src/a.ts"));
  clock.advance(1_000);
  expect(inbox).toEqual([]);
  expect(port.released).toEqual(["/w"]);
});

it("a checkout that moved under the watch asks for one re-list and stops", async () => {
  const { clock, port, watch } = setup();
  const inbox: FoldersChanged[] = [];
  let valid = true;
  await watch.watch(client("phone", inbox, { valid: () => valid }), main, "/w", ["src", "docs"]);
  valid = false;
  port.calls[0]?.onBatch(changes("src/a.ts"));
  clock.advance(100);
  expect(inbox).toMatchObject([{ threadId: main, folders: ["docs", "src"], rescan: true }]);
  expect(port.released).toEqual(["/w"]);
  // The watch is gone: a later batch says nothing more.
  port.calls[0]?.onBatch(changes("docs/b.md"));
  clock.advance(1_000);
  expect(inbox).toHaveLength(1);
});

it("a rescan reaches every client watching the checkout", async () => {
  const { clock, port, watch } = setup();
  const phone: FoldersChanged[] = [];
  const browser: FoldersChanged[] = [];
  await watch.watch(client("phone", phone), main, "/w", ["src"]);
  await watch.watch(client("browser", browser), main, "/w", ["docs"]);
  port.calls[0]?.onBatch({ type: "rescan" });
  clock.advance(100);
  expect(phone).toMatchObject([{ folders: ["src"], rescan: true }]);
  expect(browser).toMatchObject([{ folders: ["docs"], rescan: true }]);
});

it("a watcher warning re-lists every watched folder", async () => {
  const { clock, port, watch } = setup();
  const inbox: FoldersChanged[] = [];
  await watch.watch(client("phone", inbox), main, "/w", ["src", "docs"]);
  port.calls[0]?.onBatch({ type: "warning", message: "falling back to polling" });
  clock.advance(100);
  expect(inbox).toMatchObject([{ folders: ["docs", "src"], rescan: true }]);
});

it("ten thousand connect and disconnect cycles leave no session behind", async () => {
  const { port, watch } = setup();
  for (let index = 0; index < 10_000; index++) {
    await watch.watch(client(`phone-${index}`, []), main, "/w", ["src"]);
    await watch.disconnect(`phone-${index}`);
  }
  expect(watch.sessions).toBe(0);
  expect(port.released).toHaveLength(10_000);
});

it("a watch that cannot start leaves no client behind", async () => {
  const clock = new TestClock();
  const watch = new FolderWatch(new FakeWatch(new Error("FILES_RESTARTING")), { clock });
  const inbox: FoldersChanged[] = [];
  await expect(watch.watch(client("phone", inbox), main, "/w", ["src"])).rejects.toThrow(
    "FILES_RESTARTING",
  );
  await watch.disconnect("phone");
  expect(inbox).toEqual([]);
});

it("a new folder names itself and the folder that holds it", async () => {
  const { clock, port, watch } = setup();
  const inbox: FoldersChanged[] = [];
  await watch.watch(client("phone", inbox), main, "/w", ["", "src"]);
  port.calls[0]?.onBatch(folders("src"));
  clock.advance(100);
  expect(inbox).toMatchObject([{ folders: ["", "src"], rescan: false }]);
});

it("watching a ninth thread releases the oldest thread's root", async () => {
  const { watch, port } = setup();
  const inbox: FoldersChanged[] = [];
  const phone = client("phone", inbox);
  for (let index = 0; index < 9; index++) {
    await watch.watch(phone, ThreadId.parse(`t${index}`), `/w${index}`, ["src"]);
  }
  expect(port.calls.map((call) => call.path)).toEqual([
    "/w0",
    "/w1",
    "/w2",
    "/w3",
    "/w4",
    "/w5",
    "/w6",
    "/w7",
    "/w8",
  ]);
  expect(port.released).toEqual(["/w0"]);
});
