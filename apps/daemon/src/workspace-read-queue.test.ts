import { expect, test } from "vitest";
import { WorkspaceReadQueue } from "./workspace-read-queue.ts";

function gated() {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const read = (name: string) => () => {
    started.push(name);
    return new Promise<void>((resolve) => finish.set(name, resolve));
  };
  const settle = async (name: string) => {
    finish.get(name)?.();
    // Let the queue hand the freed slot on.
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { started, read, settle };
}

test("reads over the limit wait in order and start as earlier ones finish, failed or not", async () => {
  const queue = new WorkspaceReadQueue(2, 4);
  const { started, read, settle } = gated();
  for (const name of ["a", "b", "c", "d"]) expect(queue.admit(read(name))).toBe(true);
  expect(started).toEqual(["a", "b"]);
  await settle("b");
  expect(started).toEqual(["a", "b", "c"]);
  expect(queue.admit(() => Promise.reject(new Error("GitHub is down")))).toBe(true);
  await settle("a");
  await settle("c");
  expect(started).toEqual(["a", "b", "c", "d"]);
  // The failed read gave its slot back: with only "d" running, the next read starts at once.
  queue.admit(read("e"));
  expect(started).toEqual(["a", "b", "c", "d", "e"]);
});

test("a full backlog refuses the next read without starting it", () => {
  const queue = new WorkspaceReadQueue(1, 1);
  const { started, read } = gated();
  expect(queue.admit(read("running"))).toBe(true);
  expect(queue.admit(read("waiting"))).toBe(true);
  expect(queue.admit(read("refused"))).toBe(false);
  expect(started).toEqual(["running"]);
});

test("closing drops waiting reads: a closed socket's backlog never reaches GitHub", async () => {
  const queue = new WorkspaceReadQueue(1, 4);
  const { started, read, settle } = gated();
  queue.admit(read("running"));
  queue.admit(read("waiting"));
  queue.close();
  await settle("running");
  expect(queue.admit(read("late"))).toBe(false);
  expect(started).toEqual(["running"]);
});
