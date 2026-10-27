import { afterEach, expect, test, vi } from "vitest";

await vi.hoisted(async () => {
  const { createNodeHost } = await import("@ace/native-host/node");
  const host = createNodeHost({ now: () => 0 });
  Object.assign(globalThis, { aceHost: { ...host, timer: () => {}, cancelTimer: () => {} } });
});

import { CommandId, DeviceId, ThreadId, type ThreadListEntry } from "@ace/protocol";
import { FakeDaemon, facts } from "@ace/fake-daemon";
import { followInbox, inboxAction, type InboxClock } from "./inbox.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * Pinning and ordering the phone's inbox by hand, as the web's Home list does: each change
 * shows at once, is put back when the machine refuses it, and once recorded holds through a
 * reconnect, since the order is the machine's, not the phone's.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

class Clock implements InboxClock {
  now = () => 5_000_000;
  set = () => () => {};
}

function finished(daemon: FakeDaemon, id: string) {
  daemon.createThread({
    id,
    workspaceId: "ace",
    title: id,
    provider: "codex",
    hasSentMessage: true,
  });
  daemon.apply(id, [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
}
let seeds = 0;
function pin(daemon: FakeDaemon, id: string, order?: number) {
  daemon.command({
    id: CommandId.parse(`pin-${++seeds}`),
    deviceId: DeviceId.parse("seed"),
    payload: {
      type: "thread.pin",
      threadId: ThreadId.parse(id),
      pinned: true,
      ...(order === undefined ? {} : { order }),
    },
  });
}

/** The machine's own list entry, as any client would read it. */
function listed(daemon: FakeDaemon, id: string): ThreadListEntry | undefined {
  const view = daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads[id] : undefined;
}

async function following(seed: (daemon: FakeDaemon) => void) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  seed(daemon);
  await client.start();
  const sink = new RecordingSink();
  const inbox = followInbox(client, "mac", sink, new Clock());
  closers.push(inbox);
  const act = (action: Record<string, unknown>, requestId: string) =>
    inboxAction(client, action, requestId, sink, inbox);
  return { daemon, client, sink, act };
}

type Sections = { sections: { key: string; ids: string[] }[]; sortBy: string };
const layout = (sink: RecordingSink) => sink.read("inbox:sections") as Sections | undefined;
const groups = (sink: RecordingSink) =>
  Object.fromEntries((layout(sink)?.sections ?? []).map((section) => [section.key, section.ids]));
type Row = { pinned: boolean; pinOrder: number | null; listOrder: number; group: string | null };
const row = (sink: RecordingSink, id: string) =>
  (sink.read(`inbox:${id}`) as { row: Row | null } | undefined)?.row ?? undefined;
/** A group as the phone shows it, for a move: every row with its place. */
const shown = (sink: RecordingSink, key: string, place: "pinOrder" | "listOrder") =>
  (groups(sink)[key] ?? []).map((id) => ({
    machineId: "mac",
    id,
    order: row(sink, id)?.[place] ?? null,
  }));

test("pinning a thread lifts it into Pinned at once, and unpinning puts it back", async () => {
  const { daemon, sink, act } = await following((machine) => {
    finished(machine, "a");
    finished(machine, "b");
  });
  await until(() => groups(sink).done?.length === 2, "the inbox");

  act({ kind: "pin", threadId: "a", pinned: true }, "pin-a");
  // Before the machine answers.
  expect(groups(sink).pinned).toEqual(["a"]);
  expect(groups(sink).done).toEqual(["b"]);
  expect(row(sink, "a")?.pinned).toBe(true);
  await until(() => listed(daemon, "a")?.pinned === true, "the machine's pin");
  expect(sink.read("admission:pin-a")).toMatchObject({ ok: true });
  expect(groups(sink).pinned).toEqual(["a"]);

  act({ kind: "pin", threadId: "a", pinned: false }, "unpin-a");
  expect(groups(sink).pinned).toBeUndefined();
  await until(() => listed(daemon, "a")?.pinned !== true, "the machine's unpin");
  expect(groups(sink).done?.toSorted()).toEqual(["a", "b"]);
});

test("a pin the machine refuses goes back to where it was and says why", async () => {
  const { daemon, sink, act } = await following((machine) => finished(machine, "a"));
  await until(() => groups(sink).done?.length === 1, "the inbox");
  daemon.refuseCommands("Pins are off on this machine", "thread.pin");

  act({ kind: "pin", threadId: "a", pinned: true }, "pin-a");
  expect(groups(sink).pinned).toEqual(["a"]);
  await until(() => sink.read("receipt:pin-a") !== undefined, "the refusal");
  expect(sink.read("receipt:pin-a")).toMatchObject({
    ok: false,
    message: "Pins are off on this machine",
  });
  expect(groups(sink).pinned).toBeUndefined();
  expect(groups(sink).done).toEqual(["a"]);
  expect(row(sink, "a")?.pinned).toBe(false);
});

test("moving a pinned thread up a place reorders Pinned on the phone and on the machine", async () => {
  const { daemon, sink, act } = await following((machine) => {
    for (const id of ["top", "middle", "bottom"]) finished(machine, id);
    pin(machine, "top", 30);
    pin(machine, "middle", 20);
    pin(machine, "bottom", 10);
  });
  await until(() => groups(sink).pinned?.length === 3, "the pins");
  expect(groups(sink).pinned).toEqual(["top", "middle", "bottom"]);

  const group = shown(sink, "pinned", "pinOrder");
  act(
    { kind: "move", group: "pinned", machineId: "mac", threadId: "bottom", shown: group, to: 1 },
    "up",
  );
  expect(groups(sink).pinned).toEqual(["top", "bottom", "middle"]);
  await until(() => sink.read("admission:up") !== undefined, "the admission");
  expect(sink.read("admission:up")).toMatchObject({ ok: true });
  await until(() => (listed(daemon, "bottom")?.pinOrder ?? 0) > 20, "the machine's place");
  expect(listed(daemon, "bottom")?.pinOrder).toBeLessThan(30);
  expect(groups(sink).pinned).toEqual(["top", "bottom", "middle"]);
});

test("a move with no room between two machines' pins renumbers only this machine's threads", async () => {
  // The phone shows a pc pin tied with this machine's top pin; "shared" is also a thread here.
  const { daemon, sink, act } = await following((machine) => {
    for (const id of ["one", "two", "shared"]) finished(machine, id);
    pin(machine, "one", 10);
    pin(machine, "two", 5);
  });
  await until(() => groups(sink).pinned?.length === 2, "the pins");
  const group = [
    { machineId: "mac", id: "one", order: 10 },
    { machineId: "pc", id: "shared", order: 10 },
    { machineId: "mac", id: "two", order: 5 },
  ];
  act(
    { kind: "move", group: "pinned", machineId: "mac", threadId: "two", shown: group, to: 1 },
    "between",
  );
  await until(() => sink.read("admission:between") !== undefined, "the admission");
  expect(sink.read("admission:between")).toMatchObject({ ok: true });
  await until(() => listed(daemon, "two")?.pinOrder === 12, "fresh places");
  // Fresh places above every old one, in the order shown; the pc's pin is the pc's to place.
  expect(listed(daemon, "one")?.pinOrder).toBe(13);
  expect(listed(daemon, "shared")?.pinned).not.toBe(true);
  expect(groups(sink).pinned).toEqual(["one", "two"]);
});

test("a thread placed by hand while offline keeps its place after the reconnect", async () => {
  const { daemon, client, sink, act } = await following((machine) => {
    for (const id of ["a", "b", "c"]) finished(machine, id);
  });
  await until(() => groups(sink).done?.length === 3, "the inbox");
  await client.request({
    type: "settings.set",
    key: "threads.sortBy",
    value: "manual",
    layer: { kind: "global" },
  });
  await until(() => layout(sink)?.sortBy === "manual", "the hand-sorted list");
  // Newest first until placed by hand.
  expect(groups(sink).threads).toEqual(["c", "b", "a"]);

  daemon.refuseConnections(true);
  await until(() => client.connectionState().getSnapshot() !== "ready", "offline");
  const group = shown(sink, "threads", "listOrder");
  act(
    { kind: "move", group: "listed", machineId: "mac", threadId: "a", shown: group, to: 0 },
    "a-top",
  );
  await until(() => sink.read("admission:a-top") !== undefined, "saved on the phone");
  expect(sink.read("admission:a-top")).toMatchObject({ ok: true });
  expect(groups(sink).threads).toEqual(["a", "c", "b"]);

  daemon.refuseConnections(false);
  client.reconnectNow();
  await until(() => listed(daemon, "a")?.listOrder !== undefined, "the machine's place");
  await until(() => client.connectionState().getSnapshot() === "ready", "online");
  expect(groups(sink).threads).toEqual(["a", "c", "b"]);

  // A later connection reads the same order back from the machine.
  daemon.disconnectAll();
  client.reconnectNow();
  await until(() => client.connectionState().getSnapshot() === "ready", "online again");
  await until(() => row(sink, "a") !== undefined, "rows again");
  expect(groups(sink).threads).toEqual(["a", "c", "b"]);
});

test("a pinned thread that is snoozed still reads as snoozed, so its row offers Wake", async () => {
  const { sink } = await following((machine) => {
    finished(machine, "nap");
    pin(machine, "nap", 10);
    machine.command({
      id: CommandId.parse("snooze-nap"),
      deviceId: DeviceId.parse("seed"),
      payload: { type: "thread.snooze", threadId: ThreadId.parse("nap"), until: 9_000_000_000_000 },
    });
  });
  await until(() => groups(sink).pinned?.includes("nap") === true, "the pin");
  await until(() => row(sink, "nap")?.group === "snoozed", "the snooze");
  expect(groups(sink).snoozed).toBeUndefined();
});

test("a move in the list is refused while the machine doesn't sort by hand, keeping its order", async () => {
  const { daemon, sink, act } = await following((machine) => {
    for (const id of ["a", "b"]) finished(machine, id);
  });
  await until(() => groups(sink).done?.length === 2, "the inbox");
  const group = [
    { machineId: "mac", id: "b", order: 2 },
    { machineId: "mac", id: "a", order: 1 },
  ];
  act({ kind: "move", group: "listed", machineId: "mac", threadId: "a", shown: group, to: 0 }, "m");
  await until(() => sink.read("admission:m") !== undefined, "the answer");
  expect(sink.read("admission:m")).toMatchObject({ ok: false });
  expect(listed(daemon, "a")?.listOrder).toBeUndefined();
});
