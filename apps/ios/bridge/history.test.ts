import { expect, test, vi } from "vitest";

await vi.hoisted(async () => {
  const { createNodeHost } = await import("@ace/native-host/node");
  Object.assign(globalThis, { aceHost: createNodeHost({ now: () => 0 }) });
});

import { ThreadListEntry } from "@ace/protocol";
import { answerHistory, olderPages, settledHistory, type HistoryPorts } from "./history.ts";

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

/** A machine whose list holds `loaded` and pages in `older`, one entry per page, oldest last. */
function machine(input: {
  loaded: ThreadListEntry[];
  older?: ThreadListEntry[];
  hits?: string[];
  search?: () => Promise<{ threadId: string }[]>;
  loadOlder?: () => Promise<void>;
}) {
  const entries = [...input.loaded];
  const older = [...(input.older ?? [])];
  let pages = 0;
  const ports: HistoryPorts = {
    entries: () => entries,
    search: input.search ?? (async () => (input.hits ?? []).map((threadId) => ({ threadId }))),
    holdsOlder: () => older.length > 0,
    loadOlder:
      input.loadOlder ??
      (async () => {
        pages++;
        const next = older.shift();
        if (next) entries.push(next);
      }),
    now: () => now,
  };
  return { ports, pages: () => pages };
}
const ask = (query: string, extra: Record<string, unknown> = {}) => ({
  type: "history.query" as const,
  query,
  older: true,
  ...extra,
});

test("an older search hit is paged in and shown once its entry says it is settled", async () => {
  const old = entry({ id: "old", title: "Quarterly notes", activityAt: now - 40 * day });
  const { ports, pages } = machine({
    loaded: [entry({ id: "recent", title: "Recent", activityAt: now - day })],
    older: [entry({ id: "filler", title: "Filler", activityAt: now - 20 * day }), old],
    hits: ["old"],
  });
  const answer = await answerHistory(ports, ask("message words"));
  expect(answer.threads.map((thread) => thread.id)).toEqual(["old"]);
  expect(answer.threads[0]).toMatchObject({ label: "Earlier", project: "ace", listed: true });
  expect(pages()).toBe(2);
});

test("a search hit that is open, pinned, archived or a chat never enters History", async () => {
  const { ports } = machine({
    loaded: [],
    older: [
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
    hits: ["open", "pinned", "archived", "chat"],
  });
  expect((await answerHistory(ports, ask("words"))).threads).toEqual([]);
});

test("a hit the list never reaches stays out, and paging stops after a few pages", async () => {
  const older = Array.from({ length: olderPages + 3 }, (_, index) =>
    entry({ id: `page-${index}`, title: `Page ${index}`, activityAt: now - (20 + index) * day }),
  );
  const { ports, pages } = machine({ loaded: [], older, hits: ["unknown"] });
  expect((await answerHistory(ports, ask("words"))).threads).toEqual([]);
  expect(pages()).toBe(olderPages);
});

test("a re-read the paging caused doesn't page again", async () => {
  const { ports, pages } = machine({
    loaded: [],
    older: [entry({ id: "old", title: "Old", activityAt: now - 30 * day })],
    hits: ["old"],
  });
  expect((await answerHistory(ports, ask("words", { older: false }))).threads).toEqual([]);
  expect(pages()).toBe(0);
});

test("a failed search or page still answers with the loaded settled threads", async () => {
  const loaded = [entry({ id: "relay", title: "Fix the relay", activityAt: now - day })];
  const failedSearch = machine({
    loaded,
    search: () => Promise.reject(new Error("offline")),
  });
  expect(
    (await answerHistory(failedSearch.ports, ask("relay"))).threads.map((thread) => thread.id),
  ).toEqual(["relay"]);
  const failedPage = machine({
    loaded,
    older: [entry({ id: "old", title: "Old", activityAt: now - 30 * day })],
    hits: ["old"],
    loadOlder: () => Promise.reject(new Error("offline")),
  });
  expect(
    (await answerHistory(failedPage.ports, ask("relay"))).threads.map((thread) => thread.id),
  ).toEqual(["relay"]);
});

test("every machine groups against the moment the phone sends, not its own clock", async () => {
  const { ports } = machine({
    loaded: [entry({ id: "edge", title: "Edge", activityAt: now - 7 * day + 1000 })],
  });
  // The machine's clock runs ahead past the week boundary; the phone's moment decides.
  const ahead = { ...ports, now: () => now + 60_000 };
  const answer = await answerHistory(ahead, ask("", { now }));
  expect(answer.threads[0]?.label).toBe("This week");
  expect((await answerHistory(ahead, ask(""))).threads[0]?.label).toBe("Last week");
});

test("a read the phone gave up on stops paging older threads", async () => {
  const controller = new AbortController();
  const older = Array.from({ length: olderPages }, (_, index) =>
    entry({ id: `page-${index}`, title: `Page ${index}`, activityAt: now - (20 + index) * day }),
  );
  let pages = 0;
  const { ports } = machine({
    loaded: [],
    older,
    hits: ["unknown"],
    loadOlder: async () => {
      pages++;
      // A newer query arrives while the first page loads.
      controller.abort();
    },
  });
  await answerHistory(ports, ask("words"), controller.signal);
  expect(pages).toBe(1);
  // Given up before it began, it reads no page at all.
  pages = 0;
  await answerHistory(ports, ask("words"), controller.signal);
  expect(pages).toBe(0);
});
