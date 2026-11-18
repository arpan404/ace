import type { ClientApi } from "@ace/client";
import type { FilesClientMessage } from "@ace/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { watchDelay, watchFolders } from "./folder-watch.ts";

type Watch = Extract<FilesClientMessage, { type: "files.watch" }>;

function recorder() {
  const sent: Watch[] = [];
  const client: Pick<ClientApi, "send"> = {
    send: (message) => {
      if (message.type === "files.watch") sent.push(message);
    },
  };
  return { client, sent };
}

afterEach(() => vi.useRealTimers());

const advance = () => vi.advanceTimersByTime(watchDelay);

test("two trees on one thread watch one debounced union", () => {
  vi.useFakeTimers();
  const { client, sent } = recorder();
  const a = watchFolders(client, "thread-a");
  const b = watchFolders(client, "thread-a");
  a.set(["apps/"]);
  b.set(["docs/"]);
  advance();
  expect(sent).toEqual([
    { type: "files.watch", threadId: "thread-a", folders: ["", "apps", "docs"] },
  ]);
});

test("the last tree to leave stops watching; before that it narrows the union", () => {
  vi.useFakeTimers();
  const { client, sent } = recorder();
  const a = watchFolders(client, "thread-a");
  const b = watchFolders(client, "thread-a");
  a.set(["apps/"]);
  b.set(["docs/"]);
  advance();
  sent.length = 0;
  a.leave();
  advance();
  expect(sent).toEqual([{ type: "files.watch", threadId: "thread-a", folders: ["", "docs"] }]);
  sent.length = 0;
  b.leave();
  expect(sent).toEqual([{ type: "files.watch", threadId: "thread-a", folders: [] }]);
});

test("a reconnect sends the set again even when it has not changed", () => {
  vi.useFakeTimers();
  const { client, sent } = recorder();
  const a = watchFolders(client, "thread-a");
  a.set(["apps/"]);
  advance();
  expect(sent).toHaveLength(1);
  a.resume();
  advance();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
});

test("each thread has its own set, and leaving one thread leaves the other alone", () => {
  vi.useFakeTimers();
  const { client, sent } = recorder();
  const a = watchFolders(client, "thread-a");
  const b = watchFolders(client, "thread-b");
  a.set(["apps/"]);
  b.set(["docs/"]);
  advance();
  a.leave();
  advance();
  expect(sent.filter((message) => message.threadId === "thread-b")).toHaveLength(1);
  expect(sent.at(-1)).toEqual({
    type: "files.watch",
    threadId: "thread-a",
    folders: [],
  });
});

test("the union names the root, sorts, and caps at 512 folders", () => {
  vi.useFakeTimers();
  const { client, sent } = recorder();
  const a = watchFolders(client, "thread-a");
  a.set(Array.from({ length: 600 }, (_, n) => `f${n}/`));
  advance();
  const folders = sent[0]?.folders ?? [];
  expect(folders).toHaveLength(512);
  expect(folders[0]).toBe("");
  expect(folders).toContain("f511");
  expect(folders).not.toContain("f599");
});
