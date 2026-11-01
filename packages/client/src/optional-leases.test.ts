import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Client } from "./client.ts";
import type { ClientOptions } from "./types.ts";

const options: ClientOptions = {
  deviceId: DeviceId.parse("optional-lease-test"),
  credential: async () => "test-token",
  storage: { load: async () => null, save: async () => {} },
  scheduler: { set: () => () => {} },
  random: () => 0.5,
  id: () => "test-id",
  transport: () => ({ open() {}, send() {}, close() {} }),
};

/** A client with room for four threads, one of them kept for what the person opens. */
const small = () => new Client({ ...options, limits: { threads: 4, threadReserve: 1 } });

test("an optional thread takes only spare room and says no_room when there is none", async () => {
  const client = small();
  expect(client.threadRoom().getSnapshot()).toBe(3);
  const held = ["t1", "t2", "t3"].map((id) => client.thread(id, { optional: true }));
  expect(client.threadRoom().getSnapshot()).toBe(0);
  const refused = client.thread("t4", { optional: true });
  expect(refused.store.error?.code).toBe("no_room");
  // The reserved slot is still there for a thread the person opens.
  const opened = client.thread("t5");
  expect(opened.store.error).toBeUndefined();
  for (const lease of held) lease.release();
  await client.close();
});

test("a thread the person opens takes the room of one only optional views hold", async () => {
  const client = small();
  const optional = ["t1", "t2", "t3"].map((id) => client.thread(id, { optional: true }));
  const first = client.thread("t4");
  expect(first.store.error).toBeUndefined();
  // Full now: the next opened thread makes an optional one give way, and its holder hears why.
  const second = client.thread("t5");
  expect(second.store.error).toBeUndefined();
  expect(optional.filter((lease) => lease.store.error?.code === "no_room")).toHaveLength(1);
  await client.close();
});

test("an optional holder hears when room frees, so it can try again", async () => {
  const client = small();
  const held = ["t1", "t2", "t3"].map((id) => client.thread(id, { optional: true }));
  const room = client.threadRoom();
  const heard: number[] = [];
  const stop = room.subscribe(() => heard.push(room.getSnapshot()));
  held[0]?.release();
  expect(heard).toEqual([1]);
  const again = client.thread("t4", { optional: true });
  expect(again.store.error).toBeUndefined();
  expect(heard).toEqual([1, 0]);
  stop();
  await client.close();
});

test("an optional hold on a thread already open costs no room and never gives way", async () => {
  const client = small();
  const opened = client.thread("t1");
  const extra = client.thread("t1", { optional: true });
  expect(client.threadRoom().getSnapshot()).toBe(2);
  const others = ["t2", "t3"].map((id) => client.thread(id, { optional: true }));
  client.thread("t4");
  client.thread("t5");
  // Full: the thread that gave way was one only optional views held, never the open one.
  expect(others.filter((lease) => lease.store.error?.code === "no_room")).toHaveLength(1);
  expect(opened.store.error).toBeUndefined();
  expect(extra.store.error).toBeUndefined();
  await client.close();
});
