import type { ClientApi } from "@ace/client";
import type { FilesServerMessage } from "@ace/protocol";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  contentSearchStore,
  ContentSearchStore,
  retainContentSearch,
} from "./content-search-store.ts";

/** A client whose searches stay open until the test ends them, and whose pushes the test sends. */
function fakeClient() {
  const listeners = new Set<(message: FilesServerMessage) => void>();
  const requests: { requestId: string; signal: AbortSignal }[] = [];
  const client = {
    onMessage(listener: (message: FilesServerMessage) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request(_input: unknown, settings: { requestId: string; signal: AbortSignal }) {
      requests.push(settings);
      return new Promise((_, reject) =>
        settings.signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        ),
      );
    },
  } as unknown as ClientApi;
  const push = (searchId: string, path: string) => {
    const message: FilesServerMessage = {
      type: "files.search.matches",
      searchId,
      files: [{ path, lines: [{ line: 1, column: 0, preview: "hit", ranges: [[0, 3]] }] }],
    };
    for (const listener of listeners) listener(message);
  };
  return { client, requests, push };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("editing the query drops the old results and the old search at once", () => {
  const fake = fakeClient();
  const store = new ContentSearchStore(fake.client, "thread-a");
  store.update({ pattern: "old" }, true);
  const first = fake.requests[0];
  if (!first) throw new Error("no search started");
  fake.push(first.requestId, "old.ts");
  expect(store.state.files.map((file) => file.path)).toEqual(["old.ts"]);

  store.update({ pattern: "olde" });
  expect(store.state.files).toEqual([]);
  expect(first.signal.aborted).toBe(true);
  fake.push(first.requestId, "late.ts");
  expect(store.state.files).toEqual([]);
  expect(fake.requests).toHaveLength(1);

  vi.advanceTimersByTime(250);
  expect(fake.requests).toHaveLength(2);
});

test("a thread's search is let go once its Files tabs close and other threads are searched", () => {
  const fake = fakeClient();
  const release = retainContentSearch(fake.client, "closed");
  contentSearchStore(fake.client, "closed").update({ pattern: "kept" });
  release();
  for (let index = 0; index < 20; index++) retainContentSearch(fake.client, `other-${index}`)();
  expect(contentSearchStore(fake.client, "closed").state.query.pattern).toBe("");
});

test("a thread with a Files tab open keeps its search however many threads come after", () => {
  const fake = fakeClient();
  retainContentSearch(fake.client, "open");
  contentSearchStore(fake.client, "open").update({ pattern: "kept" });
  for (let index = 0; index < 20; index++) retainContentSearch(fake.client, `other-${index}`)();
  expect(contentSearchStore(fake.client, "open").state.query.pattern).toBe("kept");
});
