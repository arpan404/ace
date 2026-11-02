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
 * Settled. Each section the bridge sends names the tab that lists it, and the layout carries
 * every tab and the Inbox threads that need the person, which light its dot.
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
  sections: { key: string; tab: string; ids: string[] }[];
  tabs: { id: string; label: string; counted: boolean; empty: string; needsYou: string[] }[];
};
const layout = (sink: RecordingSink) => sink.read("inbox:sections") as Layout | undefined;
/** The thread ids each tab lists, section by section in order, as the phone draws them. */
const tabs = (sink: RecordingSink) => {
  const listed = { inbox: [] as string[], snoozed: [] as string[], settled: [] as string[] };
  for (const section of layout(sink)?.sections ?? []) {
    if (section.tab === "inbox" || section.tab === "snoozed" || section.tab === "settled")
      listed[section.tab].push(...section.ids);
  }
  return listed;
};
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
  expect(
    layout(sink)?.tabs.map(({ id, label, counted, needsYou }) => ({
      id,
      label,
      counted,
      needsYou,
    })),
  ).toEqual([
    { id: "inbox", label: "Inbox", counted: true, needsYou: [] },
    { id: "snoozed", label: "Snoozed", counted: true, needsYou: [] },
    { id: "settled", label: "Settled", counted: false, needsYou: [] },
  ]);
});

test("a snoozed thread that asks for the person comes back to the Inbox and lights its dot", async () => {
  const { daemon, sink } = await following((machine) => {
    finished(machine, "quiet");
    snooze(machine, "quiet");
    finished(machine, "other");
  });
  await until(() => tabs(sink).snoozed.includes("quiet"), "the snooze");
  expect(layout(sink)?.tabs[0]).toMatchObject({ id: "inbox", needsYou: [] });

  asking(daemon, "asks");
  snooze(daemon, "asks");
  await until(() => tabs(sink).inbox.includes("asks"), "the request");
  expect(tabs(sink).snoozed).toEqual(["quiet"]);
  expect(layout(sink)?.tabs[0]).toMatchObject({ id: "inbox", needsYou: ["asks"] });
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
