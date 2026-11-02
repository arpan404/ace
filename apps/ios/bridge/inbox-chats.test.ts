import { afterEach, expect, test, vi } from "vitest";

await vi.hoisted(async () => {
  const { createNodeHost } = await import("@ace/native-host/node");
  const host = createNodeHost({ now: () => 0 });
  Object.assign(globalThis, { aceHost: { ...host, timer: () => {}, cancelTimer: () => {} } });
});

import { FakeDaemon, facts } from "@ace/fake-daemon";
import { followInbox, inboxAction, type InboxClock } from "./inbox.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * The phone's Chats tab: chats (threads in a hidden chat project, ADR 0099) leave the Threads
 * list for their own, grouped as the web's Chats panel groups them, narrowed by the tab's
 * search, and each row offers the chat menu.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

class Clock implements InboxClock {
  now = () => 5_000_000;
  set = () => () => {};
}

function thread(daemon: FakeDaemon, id: string, title: string, chat: boolean, working = false) {
  const workspaceId = chat ? `chat-${id}` : "ace";
  daemon.createThread({
    id,
    workspaceId,
    title,
    provider: "claude",
    hasSentMessage: true,
    ...(chat
      ? {
          details: {
            workspace: { id: workspaceId, name: "Chat", path: `/c/${id}`, kind: "chat" },
            mode: "local",
          },
        }
      : {}),
  });
  daemon.apply(id, [
    facts.rootAgent("claude"),
    facts.turn("root"),
    ...(working ? [] : [facts.endTurn("root")]),
  ]);
}

async function following(seed: (daemon: FakeDaemon) => void) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  seed(daemon);
  await client.start();
  const sink = new RecordingSink();
  const follow = followInbox(client, "mac", sink, new Clock());
  closers.push(follow);
  return { client, sink, follow };
}

type Layout = { sections: { key: string; label: string; ids: string[] }[] };
const listed = (sink: RecordingSink, key: string) =>
  ((sink.read(key) as Layout | undefined)?.sections ?? []).flatMap((section) => section.ids);
const chatGroups = (sink: RecordingSink) =>
  ((sink.read("chats:sections") as Layout | undefined)?.sections ?? []).map((section) => [
    section.label,
    section.ids,
  ]);

test("chats leave Threads for the Chats tab, where work under way leads", async () => {
  const { sink } = await following((daemon) => {
    thread(daemon, "fix", "Fix the build", false);
    thread(daemon, "regex", "Regex for semver", true, true);
    thread(daemon, "trip", "Three days in Lisbon", true);
  });
  await until(() => listed(sink, "chats:sections").length === 2, "the chats");
  expect(listed(sink, "inbox:sections")).toEqual(["fix"]);
  expect(chatGroups(sink)[0]).toEqual(["Active", ["regex", "trip"]]);
});

test("the Chats search narrows chats by title, and clearing it brings them all back", async () => {
  const { client, sink, follow } = await following((daemon) => {
    thread(daemon, "regex", "Regex for semver", true);
    thread(daemon, "trip", "Three days in Lisbon", true);
  });
  await until(() => listed(sink, "chats:sections").length === 2, "the chats");
  inboxAction(client, { kind: "chatsQuery", query: "lisbon" }, "q1", sink, follow);
  expect(listed(sink, "chats:sections")).toEqual(["trip"]);
  inboxAction(client, { kind: "chatsQuery", query: "" }, "q2", sink, follow);
  expect(listed(sink, "chats:sections").toSorted()).toEqual(["regex", "trip"]);
});

test("a chat's row offers Rename, Pin, Move to project and Delete; a project thread's offers none", async () => {
  const { sink } = await following((daemon) => {
    thread(daemon, "fix", "Fix the build", false);
    thread(daemon, "trip", "Three days in Lisbon", true);
  });
  const menu = (id: string) =>
    (sink.read(`inbox:${id}`) as { row: { chatMenu: string[] | null } } | undefined)?.row.chatMenu;
  await until(() => menu("trip") !== undefined, "the chat row");
  expect(menu("trip")).toEqual(["rename", "pin", "move", "delete"]);
  expect(menu("fix")).toBeNull();
});
