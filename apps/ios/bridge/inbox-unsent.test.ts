import { afterEach, expect, test, vi } from "vitest";

await vi.hoisted(async () => {
  const { createNodeHost } = await import("@ace/native-host/node");
  const host = createNodeHost({ now: () => 0 });
  Object.assign(globalThis, { aceHost: { ...host, timer: () => {}, cancelTimer: () => {} } });
});

import { ThreadId } from "@ace/protocol";
import { followInbox, type InboxClock } from "./inbox.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * A message the machine turned down, as the phone's composer shows it: "Not sent" with the
 * reason the person acts on.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

class Clock implements InboxClock {
  now = () => 5_000_000;
  set = () => () => {};
}

type Unsent = { state: string; label: string; reason: string; detail: string };

async function refusedSend(error: string) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  daemon.createThread({
    id: "moved",
    workspaceId: "ace",
    title: "Moved",
    provider: "codex",
    hasSentMessage: true,
  });
  daemon.refuseCommands(error, "thread.send");
  await client.start();
  const sink = new RecordingSink();
  closers.push(followInbox(client, "mac", sink, new Clock()));
  const sent = client.command({
    type: "thread.send",
    threadId: ThreadId.parse("moved"),
    input: [{ type: "text", text: "Keep going" }],
  });
  void sent.catch(() => {});
  const failed = () =>
    client
      .pendingSends()
      .getSnapshot()
      .find((send) => send.state === "failed");
  await until(() => failed() !== undefined, "the refusal");
  const id = failed()?.commandId;
  return () => (sink.read(`pending:${id}`) as { row: Unsent | null } | undefined)?.row;
}

test("a send refused because the thread's work moved says to continue it there", async () => {
  const row = await refusedSend("thread_moved");
  await until(() => row()?.state === "failed", "the not-sent row");
  expect(row()).toMatchObject({
    label: "Not sent",
    reason: "This thread moved to another machine. Continue it there.",
  });
});

test("any other refusal keeps its code behind Details and says nothing beside Not sent", async () => {
  const row = await refusedSend("thread_busy");
  await until(() => row()?.state === "failed", "the not-sent row");
  expect(row()).toMatchObject({ label: "Not sent", reason: "", detail: "thread_busy" });
});
