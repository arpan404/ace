import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import type { EventPayload } from "@ace/files-native";
import { WatchFanout, type FoldersUpdate } from "./watch-fanout.ts";
import { TestClock } from "./test-clock.ts";

const main = ThreadId.parse("main");
const other = ThreadId.parse("other");

function fanout() {
  const clock = new TestClock();
  const sent: { client: string; update: FoldersUpdate }[] = [];
  const watch = new WatchFanout({
    clock,
    send: (client, update) => sent.push({ client, update }),
  });
  return { clock, sent, watch };
}

function changes(...paths: (string | [string, boolean])[]): EventPayload {
  return {
    type: "changes",
    changes: paths.map((entry) => {
      const [path, directory] = typeof entry === "string" ? [entry, false] : entry;
      return { path, kind: "modified", directory };
    }),
  };
}

const rescan: EventPayload = { type: "rescan" };

it("names the folder that holds a changed file", () => {
  const { clock, sent, watch } = fanout();
  watch.watch("phone", main, "/w", ["src", "docs"]);
  watch.batch("/w", changes("src/a.ts"));
  clock.advance(100);
  expect(sent).toEqual([
    { client: "phone", update: { threadId: main, folders: ["src"], rescan: false } },
  ]);
});

it("says nothing for changes outside the watched folders", () => {
  const { clock, sent, watch } = fanout();
  watch.watch("phone", main, "/w", ["src"]);
  watch.batch("/w", changes("lib/a.ts", "docs/b.md"));
  clock.advance(1_000);
  expect(sent).toEqual([]);
});

it("names a changed folder itself as well as the folder that holds it", () => {
  const { clock, sent, watch } = fanout();
  watch.watch("phone", main, "/w", ["", "src"]);
  watch.batch("/w", changes(["src", true]));
  clock.advance(100);
  expect(sent.map((entry) => entry.update.folders)).toEqual([["", "src"]]);
});

it("keeps each client to its own folders", () => {
  const { clock, sent, watch } = fanout();
  watch.watch("phone", main, "/w", ["src"]);
  watch.watch("browser", main, "/w", ["docs"]);
  watch.batch("/w", changes("src/a.ts", "docs/b.md"));
  clock.advance(100);
  expect(sent).toEqual([
    { client: "phone", update: { threadId: main, folders: ["src"], rescan: false } },
    { client: "browser", update: { threadId: main, folders: ["docs"], rescan: false } },
  ]);
});

it("coalesces everything a client hears in one window into one message", () => {
  const { clock, sent, watch } = fanout();
  watch.watch("phone", main, "/w", ["src", "docs"]);
  watch.batch("/w", changes("src/a.ts"));
  clock.advance(40);
  watch.batch("/w", changes("docs/b.md"));
  clock.advance(59);
  expect(sent).toEqual([]);
  clock.advance(1);
  expect(sent).toEqual([
    { client: "phone", update: { threadId: main, folders: ["docs", "src"], rescan: false } },
  ]);
  watch.batch("/w", changes("docs/c.md"));
  clock.advance(100);
  expect(sent).toHaveLength(2);
  expect(sent[1]?.update.folders).toEqual(["docs"]);
});

it("a rescan re-lists every watched folder", () => {
  const { clock, sent, watch } = fanout();
  watch.watch("phone", main, "/w", ["src", "docs"]);
  watch.batch("/w", rescan);
  watch.batch("/w", changes("src/a.ts"));
  clock.advance(100);
  expect(sent).toEqual([
    { client: "phone", update: { threadId: main, folders: ["docs", "src"], rescan: true } },
  ]);
});

it("replaces a client's folder set instead of adding to it", () => {
  const { clock, sent, watch } = fanout();
  watch.watch("phone", main, "/w", ["src"]);
  watch.watch("phone", main, "/w", ["docs"]);
  watch.batch("/w", changes("src/a.ts"));
  clock.advance(1_000);
  expect(sent).toEqual([]);
  watch.batch("/w", changes("docs/b.md"));
  clock.advance(100);
  expect(sent.map((entry) => entry.update.folders)).toEqual([["docs"]]);
});

it("keeps a pending change the new folder set still watches", () => {
  const { clock, sent, watch } = fanout();
  watch.watch("phone", main, "/w", ["A"]);
  watch.batch("/w", changes("A/file.ts"));
  clock.advance(40);
  watch.watch("phone", main, "/w", ["A", "B"]);
  clock.advance(60);
  expect(sent).toEqual([
    { client: "phone", update: { threadId: main, folders: ["A"], rescan: false } },
  ]);
});

it("keeps a pending rescan when the folder set is replaced", () => {
  const { clock, sent, watch } = fanout();
  watch.watch("phone", main, "/w", ["A"]);
  watch.batch("/w", rescan);
  clock.advance(40);
  watch.watch("phone", main, "/w", ["A", "B"]);
  clock.advance(60);
  expect(sent).toEqual([
    { client: "phone", update: { threadId: main, folders: ["A", "B"], rescan: true } },
  ]);
});

it("drops a pending change when the thread moves to another checkout", () => {
  const { clock, sent, watch } = fanout();
  watch.watch("phone", main, "/one", ["A"]);
  watch.batch("/one", changes("A/file.ts"));
  watch.watch("phone", main, "/two", ["A"]);
  clock.advance(1_000);
  expect(sent).toEqual([]);
});

it("an empty folder set stops watching", () => {
  const { clock, sent, watch } = fanout();
  watch.watch("phone", main, "/w", ["src"]);
  watch.watch("phone", main, "/w", []);
  watch.batch("/w", changes("src/a.ts"));
  clock.advance(1_000);
  expect(sent).toEqual([]);
});

it("a disconnected client hears nothing more", () => {
  const { clock, sent, watch } = fanout();
  watch.watch("phone", main, "/w", ["src"]);
  watch.batch("/w", changes("src/a.ts"));
  watch.disconnect("phone");
  clock.advance(1_000);
  expect(sent).toEqual([]);
});

it("a watcher warning re-lists every watched folder", () => {
  const { clock, sent, watch } = fanout();
  watch.watch("phone", main, "/w", ["src", "docs"]);
  watch.batch("/w", { type: "warning", message: "polling" });
  clock.advance(100);
  expect(sent).toEqual([
    { client: "phone", update: { threadId: main, folders: ["docs", "src"], rescan: true } },
  ]);
});

it("names folders the way a client writes them", () => {
  const { clock, sent, watch } = fanout();
  watch.watch("phone", main, "/w", ["./src/", "docs/"]);
  watch.batch("/w", changes("src/a.ts", "docs/b.md"));
  clock.advance(100);
  expect(sent.map((entry) => entry.update.folders)).toEqual([["docs", "src"]]);
});

it("each thread of one client hears only its own folders", () => {
  const { clock, sent, watch } = fanout();
  watch.watch("phone", main, "/w", ["src"]);
  watch.watch("phone", other, "/w", ["docs"]);
  watch.batch("/w", changes("src/a.ts", "docs/b.md"));
  clock.advance(100);
  expect(sent).toEqual([
    { client: "phone", update: { threadId: main, folders: ["src"], rescan: false } },
    { client: "phone", update: { threadId: other, folders: ["docs"], rescan: false } },
  ]);
});

it("a batch only reaches the watchers of its own root", () => {
  const { clock, sent, watch } = fanout();
  watch.watch("phone", main, "/one", ["src"]);
  watch.watch("phone", other, "/two", ["src"]);
  watch.batch("/one", changes("src/a.ts"));
  clock.advance(100);
  expect(sent).toEqual([
    { client: "phone", update: { threadId: main, folders: ["src"], rescan: false } },
  ]);
});

it("keeps at most eight watched threads per client and forgets the oldest", () => {
  const { clock, sent, watch } = fanout();
  const threads = Array.from({ length: 9 }, (_, index) => ThreadId.parse(`t${index}`));
  for (const [index, threadId] of threads.entries()) {
    watch.watch("phone", threadId, `/w${index}`, ["src"]);
  }
  watch.batch("/w0", changes("src/a.ts"));
  clock.advance(1_000);
  expect(sent).toEqual([]);
  watch.batch("/w8", changes("src/a.ts"));
  clock.advance(100);
  expect(sent.map((entry) => entry.update.threadId)).toEqual([threads[8]]);
});

it("a thread watched again after eviction is re-listed in full", () => {
  const { clock, sent, watch } = fanout();
  const threads = Array.from({ length: 9 }, (_, index) => ThreadId.parse(`t${index}`));
  for (const [index, threadId] of threads.entries()) {
    watch.watch("phone", threadId, `/w${index}`, ["src", "docs"]);
  }
  watch.watch("phone", threads[0] as (typeof threads)[number], "/w0", ["src"]);
  clock.advance(100);
  expect(sent).toEqual([
    { client: "phone", update: { threadId: threads[0], folders: ["src"], rescan: true } },
  ]);
});
