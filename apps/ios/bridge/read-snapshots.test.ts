import { afterEach, expect, test, vi } from "vitest";

await vi.hoisted(async () => {
  const { createNodeHost } = await import("@ace/native-host/node");
  // Timers never fire: these tests drive time themselves.
  const host = createNodeHost({ now: () => 0 });
  Object.assign(globalThis, { aceHost: { ...host, timer: () => {}, cancelTimer: () => {} } });
});

import { Client, type ClientOptions } from "@ace/client";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { followInbox } from "./inbox.ts";
import { requester, type HostRequest } from "@ace/native-host";
import { createNodeHost } from "@ace/native-host/node";
import { z } from "zod";
import { nativeReadSnapshots } from "./read-snapshots.ts";
import { RecordingSink, until } from "./sheet-fixture.ts";

/*
 * The phone's read snapshots through the host calls the native store answers: a launch that
 * cannot reach its machine still lists the threads it read last time, as Syncing, never Done.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

/** The native snapshot store's contract (`SnapshotStore.swift`), over a map, through the host. */
function nativeStore(): HostRequest {
  const records = new Map<string, string>();
  return requester(
    createNodeHost({
      operations: {
        "snapshot.get": (key) => records.get(String(key)) ?? "",
        "snapshot.set": (input, body) => {
          const { key } = z.object({ key: z.string() }).parse(input);
          records.set(key, body ?? "");
          return "";
        },
        "snapshot.clear": () => {
          records.clear();
          return "";
        },
      },
    }),
  );
}

function phone(daemon: FakeDaemon, call: HostRequest, transport: ClientOptions["transport"]) {
  let ids = 0;
  const client = new Client({
    deviceId: DeviceId.parse("ios-snapshot-device"),
    expectedHostId: daemon.hostId,
    transport,
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    readSnapshots: nativeReadSnapshots(call),
    scheduler: {
      set(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: () => `id-${++ids}`,
  });
  closers.push(() => client.close());
  return client;
}

test("a launch that cannot reach its machine still lists what it read last time, as Syncing", async () => {
  const daemon = new FakeDaemon({ clock: () => 1_000 });
  daemon.createThread({
    id: "done",
    workspaceId: "ace",
    title: "Done",
    provider: "codex",
    hasSentMessage: true,
  });
  daemon.apply("done", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  const call = nativeStore();

  const first = phone(daemon, call, () => fakeTransport(daemon));
  await first.start();
  const firstSink = new RecordingSink();
  const stopFirst = followInbox(first, "mac", firstSink, { now: () => 2_000, set: () => () => {} });
  await until(
    () =>
      (firstSink.read("inbox:done") as { row?: { confirmed?: boolean } } | undefined)?.row
        ?.confirmed === true,
    "first launch confirmed",
  );
  stopFirst();
  await first.close();

  // Relaunched with the machine out of reach: the socket never opens.
  const offline = phone(daemon, call, () => ({ open() {}, send() {}, close() {} }));
  await offline.start();
  const sink = new RecordingSink();
  closers.push(followInbox(offline, "mac", sink, { now: () => 3_000, set: () => () => {} }));
  await until(() => sink.read("inbox:reset") !== undefined, "restored list");
  const row = sink.read("inbox:done") as { row: { status: { label: string }; confirmed: boolean } };
  expect(row.row.status.label).toBe("Syncing");
  expect(row.row.confirmed).toBe(false);
});
