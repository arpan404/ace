import { afterEach, expect, test } from "vitest";
import { deviceDrafts } from "./device-drafts.ts";

/*
 * Drafts on the device: a page that is hiding gets no task after its pagehide handler, so a
 * write to an open database must start in the caller's own task. The stand-in below is the
 * smallest IndexedDB the store uses, recording when each write reaches it.
 */

type Listener = () => void;

function evented<T extends object>(fields: T) {
  const listeners = new Map<string, Listener[]>();
  return Object.assign(fields, {
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    fire(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  });
}

function fakeIndexedDB() {
  const rows = new Map<string, unknown>();
  const db = evented({
    createObjectStore: () => ({ createIndex: () => undefined }),
    transaction() {
      const transaction = evented({
        objectStore: () => ({
          put(value: { root: string; path: string }) {
            rows.set(`${value.root}/${value.path}`, value);
            setTimeout(() => transaction.fire("complete"));
          },
          delete(key: string[]) {
            rows.delete(key.join("/"));
            setTimeout(() => transaction.fire("complete"));
          },
        }),
      });
      return transaction;
    },
  });
  return {
    factory: {
      open() {
        const opening = evented({ result: db, error: null });
        setTimeout(() => opening.fire("success"));
        return opening;
      },
    },
    rows,
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "indexedDB");
});

test("a write to an open database starts before the call returns", async () => {
  const fake = fakeIndexedDB();
  Reflect.set(globalThis, "indexedDB", fake.factory);
  const drafts = deviceDrafts("test-drafts");
  const key = { root: "m1/t1", path: "store.ts" };
  await drafts.put(key, { text: "one\n", original: "", version: "v1" });

  const writing = drafts.put(key, { text: "two\n", original: "", version: "v1" });
  expect(fake.rows.get("m1/t1/store.ts")).toMatchObject({ text: "two\n" });
  await writing;

  void drafts.delete(key);
  expect(fake.rows.has("m1/t1/store.ts")).toBe(false);
});
