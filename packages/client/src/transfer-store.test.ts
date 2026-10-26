import { Transfer } from "@ace/protocol";
import { expect, test } from "vitest";
import { TransferStore } from "./transfers.ts";

const report = (changes: Partial<Transfer>): Transfer =>
  Transfer.parse({
    transferId: "transfer-1",
    commandId: "command-1",
    kind: "thread",
    workspaceId: "weather",
    threadId: "thread-forecast",
    target: { hostId: "build", name: "Build server" },
    phase: "sending",
    sentBytes: 0,
    startedAt: 1,
    updatedAt: 1,
    ...changes,
  });

test("pushes update the thread's latest transfer", () => {
  const store = new TransferStore();
  store.apply(report({ phase: "preparing", updatedAt: 1 }));
  store.apply(report({ phase: "sending", sentBytes: 10, updatedAt: 2 }));
  expect(store.forThread("thread-forecast")).toMatchObject({ phase: "sending", sentBytes: 10 });
});

test("an older report never replaces a newer one", () => {
  const store = new TransferStore();
  store.apply(report({ phase: "importing", updatedAt: 5 }));
  store.apply(report({ phase: "sending", updatedAt: 3 }));
  expect(store.forThread("thread-forecast")?.phase).toBe("importing");
});

test("a list answered before a newer push never undoes it, and adds what it alone knew", () => {
  const store = new TransferStore();
  store.apply(report({ phase: "completed", updatedAt: 9 }));
  store.seed([
    report({ phase: "sending", updatedAt: 4 }),
    report({ transferId: "transfer-2", kind: "project", threadId: undefined, startedAt: 2 }),
  ]);
  expect(store.forThread("thread-forecast")?.phase).toBe("completed");
  expect(store.forProject("weather")?.transferId).toBe("transfer-2");
});

test("it is seeded once a list answered or couldn't be read, and listeners hear it", () => {
  const listed = new TransferStore();
  let heard = 0;
  listed.subscribe(() => heard++);
  expect(listed.seeded()).toBe(false);
  listed.seed([]);
  expect(listed.seeded()).toBe(true);
  expect(heard).toBe(1);

  const failed = new TransferStore();
  failed.unlisted();
  expect(failed.seeded()).toBe(true);
});

test("after a reconnect only that connection's list seeds the store; an older one just merges", () => {
  const store = new TransferStore();
  const first = store.relist();
  store.seed([], first);
  expect(store.seeded()).toBe(true);

  const second = store.relist();
  expect(store.seeded()).toBe(false);
  store.seed([report({ phase: "sending", updatedAt: 2 })], first);
  store.unlisted(first);
  expect(store.seeded()).toBe(false);
  expect(store.forThread("thread-forecast")?.phase).toBe("sending");

  store.seed([], second);
  expect(store.seeded()).toBe(true);
});
