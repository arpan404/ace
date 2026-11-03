import { afterEach, expect, test, vi } from "vitest";

await vi.hoisted(async () => {
  const { createNodeHost } = await import("@ace/native-host/node");
  const host = createNodeHost({ now: () => 0 });
  Object.assign(globalThis, { aceHost: { ...host, timer: () => {}, cancelTimer: () => {} } });
});

import {
  CommandId,
  DeviceId,
  InteractionRequest,
  ThreadId,
  type CommandPayload,
} from "@ace/protocol";
import { FakeDaemon, facts } from "@ace/fake-daemon";
import { followInbox, type InboxClock } from "./inbox.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * The phone's Threads screen has the desktop's three tabs (ADR 0107): Inbox, Snoozed and
 * Settled, listing what the daemon placed in each. The layout carries those lists, each tab's
 * words, and the daemon's own count of what needs the person, which lights the Inbox's dot.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

const now = 5_000_000;
const wakesAt = 9_000_000_000_000;

class Clock implements InboxClock {
  now = () => now;
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
function working(daemon: FakeDaemon, id: string) {
  daemon.createThread({
    id,
    workspaceId: "ace",
    title: id,
    provider: "codex",
    hasSentMessage: true,
  });
  daemon.apply(id, [facts.rootAgent("codex"), facts.turn("root")]);
}
function asking(daemon: FakeDaemon, id: string) {
  daemon.createThread({
    id,
    workspaceId: "ace",
    title: id,
    provider: "claude",
    hasSentMessage: true,
  });
  daemon.apply(id, [
    facts.rootAgent("claude"),
    facts.turn("root"),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "ask",
      blocking: true,
      request: InteractionRequest.parse({
        kind: "approval",
        title: "Run the tests",
        options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
      }),
    },
  ]);
}
let seeds = 0;
function command(daemon: FakeDaemon, payload: CommandPayload) {
  daemon.command({
    id: CommandId.parse(`seed-${++seeds}`),
    deviceId: DeviceId.parse("seed"),
    payload,
  });
}
const snooze = (daemon: FakeDaemon, id: string) =>
  command(daemon, { type: "thread.snooze", threadId: ThreadId.parse(id), until: wakesAt });
const settle = (daemon: FakeDaemon, id: string) =>
  command(daemon, { type: "thread.settle", threadId: ThreadId.parse(id) });
const pin = (daemon: FakeDaemon, id: string) =>
  command(daemon, { type: "thread.pin", threadId: ThreadId.parse(id), pinned: true });

async function following(seed: (daemon: FakeDaemon) => void) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  seed(daemon);
  await client.start();
  const sink = new RecordingSink();
  closers.push(followInbox(client, "mac", sink, new Clock()));
  return { daemon, sink };
}

type Layout = {
  tabs: { inbox: string[]; snoozed: string[]; settled: string[] };
  tabWords: { id: string; label: string; counted: boolean; empty: string }[];
  attention?: { threads: { needsYou: number } };
};
const layout = (sink: RecordingSink) => sink.read("inbox:sections") as Layout | undefined;
/** The thread ids each tab lists, as the daemon placed them. */
const tabs = (sink: RecordingSink) =>
  layout(sink)?.tabs ?? { inbox: [] as string[], snoozed: [] as string[], settled: [] as string[] };
const dot = (sink: RecordingSink) => layout(sink)?.attention?.threads.needsYou ?? 0;
type Row = { snoozedUntil?: number | null; look: { settled: boolean } };
const row = (sink: RecordingSink, id: string) =>
  (sink.read(`inbox:${id}`) as { row: Row | null } | undefined)?.row ?? undefined;

test("each tab lists its own threads: live and pinned in Inbox, snoozed with its wake, settled dimmed", async () => {
  const { sink } = await following((daemon) => {
    working(daemon, "live");
    finished(daemon, "kept");
    pin(daemon, "kept");
    finished(daemon, "nap");
    snooze(daemon, "nap");
    finished(daemon, "done");
    settle(daemon, "done");
  });
  await until(() => tabs(sink).settled.includes("done"), "the settled thread");
  await until(() => tabs(sink).snoozed.includes("nap"), "the snoozed thread");

  expect(tabs(sink)).toEqual({ inbox: ["kept", "live"], snoozed: ["nap"], settled: ["done"] });
  expect(row(sink, "nap")?.snoozedUntil).toBe(wakesAt);
  expect(row(sink, "done")?.look.settled).toBe(true);
  expect(row(sink, "live")?.look.settled).toBe(false);
  expect(layout(sink)?.tabWords.map(({ id, label, counted }) => ({ id, label, counted }))).toEqual([
    { id: "inbox", label: "Inbox", counted: true },
    { id: "snoozed", label: "Snoozed", counted: true },
    { id: "settled", label: "Settled", counted: false },
  ]);
  expect(dot(sink)).toBe(0);
});

test("a snoozed thread that asks for the person comes back to the Inbox and lights its dot", async () => {
  const { daemon, sink } = await following((machine) => {
    finished(machine, "quiet");
    snooze(machine, "quiet");
    finished(machine, "other");
  });
  await until(() => tabs(sink).snoozed.includes("quiet"), "the snooze");
  expect(dot(sink)).toBe(0);

  asking(daemon, "asks");
  snooze(daemon, "asks");
  await until(() => tabs(sink).inbox.includes("asks"), "the request");
  expect(tabs(sink).snoozed).toEqual(["quiet"]);
  await until(() => dot(sink) === 1, "the dot");
});

test("a pinned thread the person settles rests in Settled, not among the pinned", async () => {
  const { sink } = await following((daemon) => {
    finished(daemon, "kept");
    pin(daemon, "kept");
    settle(daemon, "kept");
  });
  await until(() => tabs(sink).settled.includes("kept"), "the settle");
  expect(tabs(sink).inbox).toEqual([]);
});
