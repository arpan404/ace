import { afterEach, expect, test, vi } from "vitest";

vi.hoisted(() => {
  let next = 0;
  Object.assign(globalThis, {
    aceHost: {
      now: () => 0,
      uuid: () => `id-${++next}`,
      previewHead: (text: string, limit: number) => text.slice(0, limit),
      previewTail: (text: string, limit: number) => text.slice(-limit),
      emit: () => {},
      timer: () => {},
      cancelTimer: () => {},
      utf8Base64: (text: string) => Buffer.from(text, "utf8").toString("base64"),
    },
  });
});

import { Client, type ClientOptions } from "@ace/client";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { followInbox } from "./inbox.ts";
import { nativeReadSnapshots, type HostCall } from "./read-snapshots.ts";
import { RecordingSink, until } from "./sheet-fixture.ts";

/*
 * The phone's read snapshots through the host calls the native store answers: a launch that
 * cannot reach its machine still lists the threads it read last time, as Syncing, never Done.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

/** The native snapshot store's contract (`SnapshotStore.swift`), over a map. */
function nativeStore(): HostCall {
  const records = new Map<string, string>();
  return async (operation, input) => {
    if (operation === "snapshot.get") return records.get(input as string) ?? "";
    if (operation === "snapshot.set") {
      const { key, value } = input as { key: string; value: string };
      records.set(key, value);
      return "";
    }
    if (operation === "snapshot.clear") {
      records.clear();
      return "";
    }
    throw new Error("unsupported");
  };
}

function phone(daemon: FakeDaemon, call: HostCall, transport: ClientOptions["transport"]) {
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
  daemon.createThread({ id: "done", workspaceId: "ace", title: "Done", provider: "codex", hasSentMessage: true });
  daemon.apply("done", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  const call = nativeStore();

  const first = phone(daemon, call, () => fakeTransport(daemon));
  await first.start();
  const firstSink = new RecordingSink();
  const stopFirst = followInbox(first, "mac", firstSink, { now: () => 2_000, set: () => () => {} });
  await until(
    () => (firstSink.read("inbox:done") as { row?: { confirmed?: boolean } } | undefined)?.row?.confirmed === true,
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
