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

  constructor(failure?: Error) {
    this.failure = failure;
  }

  watch(path: string, onBatch: (payload: EventPayload) => void): Promise<() => Promise<void>> {
    if (this.failure) return Promise.reject(this.failure);
    this.calls.push({ path, onBatch });
    return Promise.resolve(async () => {
      this.released.push(path);
    });
  }
}

function client(id: string, inbox: FoldersChanged[], canSend = true): FolderWatchClient {
  return {
    id,
    canSend: () => canSend,
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

it("a socket that may no longer read hears nothing", async () => {
  const { clock, port, watch } = setup();
  const inbox: FoldersChanged[] = [];
  await watch.watch(client("phone", inbox, false), main, "/w", ["src"]);
  port.calls[0]?.onBatch(changes("src/a.ts"));
  clock.advance(1_000);
  expect(inbox).toEqual([]);
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
