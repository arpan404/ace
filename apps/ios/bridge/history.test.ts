import { expect, test, vi } from "vitest";

await vi.hoisted(async () => {
  const { createNodeHost } = await import("@ace/native-host/node");
  Object.assign(globalThis, { aceHost: createNodeHost({ now: () => 0 }) });
});

import { ThreadListEntry } from "@ace/protocol";
import { settledHistory } from "./history.ts";

/*
 * History on the phone lists what the web's History lists: settled threads, newest first, under
 * This week, Last week and Earlier, narrowed by the web's search rule.
 */

const day = 24 * 60 * 60 * 1000;
const now = 100 * day;

const project = (id: string, name: string, kind?: "chat") => ({
  id,
  name,
  path: `/src/${id}`,
  ...(kind ? { kind } : {}),
});

function entry(fields: Record<string, unknown>): ThreadListEntry {
  return ThreadListEntry.parse({
    workspaceId: "ace",
    provider: "codex",
    createdAt: 1,
    updatedAt: 1,
    hasSentMessage: true,
    status: { state: "done" },
    readAt: now,
    settledAt: 1,
    settledReason: "manual",
    details: { workspace: project("ace", "ace") },
    ...fields,
  });
}

test("history lists settled threads newest first, under the web's week groups", () => {
  const threads = settledHistory(
    [
      entry({ id: "old", title: "Old", activityAt: now - 30 * day }),
      entry({ id: "recent", title: "Recent", activityAt: now - day }),
      entry({ id: "last", title: "Last", activityAt: now - 10 * day }),
    ],
    "",
    now,
  );
  expect(threads.map((thread) => [thread.id, thread.label])).toEqual([
    ["recent", "This week"],
    ["last", "Last week"],
    ["old", "Earlier"],
  ]);
  expect(threads[0]).toMatchObject({ project: "ace", workspaceId: "ace", listed: true });
});

test("history leaves out threads still in the inbox, pinned, archived and chats", () => {
  const threads = settledHistory(
    [
      entry({ id: "settled", title: "Settled", activityAt: now - day }),
      entry({ id: "open", title: "Open", activityAt: now - day, settledAt: undefined }),
      entry({ id: "pinned", title: "Pinned", activityAt: now - day, pinned: true }),
      entry({ id: "archived", title: "Archived", activityAt: now - day, archivedAt: now }),
      entry({
        id: "chat",
        title: "Chat",
        activityAt: now - day,
        workspaceId: "chat",
        details: { workspace: project("chat", "Chat", "chat") },
      }),
    ],
    "",
    now,
  );
  expect(threads.map((thread) => thread.id)).toEqual(["settled"]);
});

test("a history search matches titles, projects and branches", () => {
  const entries = [
    entry({ id: "relay", title: "Fix the relay", activityAt: now - day }),
    entry({
      id: "branch",
      title: "Tidy up",
      activityAt: now - 2 * day,
      workspaceId: "notes",
      details: { workspace: project("notes", "notes"), branch: "feature/relay-timeout" },
    }),
    entry({ id: "other", title: "Write docs", activityAt: now - 3 * day }),
  ];
  expect(settledHistory(entries, "relay", now).map((thread) => thread.id)).toEqual([
    "relay",
    "branch",
  ]);
  expect(settledHistory(entries, "notes", now).map((thread) => thread.id)).toEqual(["branch"]);
  expect(settledHistory(entries, "nothing like it", now)).toEqual([]);
});
