import { afterEach, expect, test, vi } from "vitest";

await vi.hoisted(async () => {
  const { createNodeHost } = await import("@ace/native-host/node");
  const host = createNodeHost({ now: () => 0 });
  Object.assign(globalThis, { aceHost: { ...host, timer: () => {}, cancelTimer: () => {} } });
});

import { FakeDaemon, facts } from "@ace/fake-daemon";
import type { HomeSort } from "@ace/ui-core";
import { followInbox, type InboxClock } from "./inbox.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * The phone's inbox follows the machine's Sort threads setting, the one the web's Home list
 * reads, so both clients agree on the order and a choice made on either moves the other.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

/** An older thread still working and a newer one finished. */
function seed(daemon: FakeDaemon) {
  daemon.createThread({
    id: "older",
    workspaceId: "ace",
    title: "Older",
    provider: "codex",
    hasSentMessage: true,
  });
  daemon.apply("older", [facts.rootAgent("codex"), facts.turn("root")]);
  daemon.createThread({
    id: "newer",
    workspaceId: "ace",
    title: "Newer",
    provider: "codex",
    hasSentMessage: true,
  });
  daemon.apply("newer", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
}

type Layout = { sections: { key: string; ids: string[] }[]; sortBy: string };
const layout = (sink: RecordingSink) => sink.read("inbox:sections") as Layout | undefined;
const groups = (sink: RecordingSink) =>
  Object.fromEntries((layout(sink)?.sections ?? []).map((section) => [section.key, section.ids]));
/** The phone's timers, fired when the test says. */
class Timers implements InboxClock {
  due: (() => void)[] = [];
  now = () => 5_000_000;
  set = (_delayMs: number, run: () => void) => {
    this.due.push(run);
    return () => {
      this.due = this.due.filter((other) => other !== run);
    };
  };
  fire() {
    for (const run of this.due.splice(0)) run();
  }
}

async function following(lastSort?: HomeSort, unreadable = false) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  seed(daemon);
  if (unreadable) daemon.failRequests("settings.subscribe");
  await client.start();
  const sink = new RecordingSink();
  const timers = new Timers();
  closers.push(followInbox(client, "mac", sink, timers, undefined, undefined, lastSort));
  return { daemon, client, sink, timers };
}

const sortOn = (client: Awaited<ReturnType<typeof following>>["client"], value: HomeSort) =>
  client.request({
    type: "settings.set",
    key: "threads.sortBy",
    value,
    layer: { kind: "global" },
  });

test("a sort chosen on another device turns the phone's inbox into one list, newest first", async () => {
  const { client, sink } = await following();
  await until(() => groups(sink).done !== undefined, "the inbox");
  expect(groups(sink)).toEqual({ working: ["older"], done: ["newer"] });
  expect(layout(sink)?.sortBy).toBe("activity");

  await sortOn(client, "created");
  await until(() => layout(sink)?.sortBy === "created", "the new sort");
  expect(groups(sink)).toEqual({ threads: ["newer", "older"] });

  await sortOn(client, "activity");
  await until(() => layout(sink)?.sortBy === "activity", "live activity again");
  expect(groups(sink)).toEqual({ working: ["older"], done: ["newer"] });
});

test("the inbox keeps the sort it was last drawn in until the machine's setting can be read", async () => {
  const { daemon, sink, timers } = await following("created", true);
  await until(() => layout(sink) !== undefined && timers.due.length > 0, "a failed read");
  expect(groups(sink)).toEqual({ threads: ["newer", "older"] });
  // The machine never changed its sort from live activity; its answer wins once it comes.
  daemon.restoreRequests();
  timers.fire();
  await until(() => layout(sink)?.sortBy === "activity", "the machine's sort");
  expect(groups(sink)).toEqual({ working: ["older"], done: ["newer"] });
});
