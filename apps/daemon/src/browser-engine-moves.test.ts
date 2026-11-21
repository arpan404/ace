import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { SqliteEngineMoveJournal } from "./browser-engine-moves.ts";

const tabs = [
  { tabId: "tab-1", position: 0, url: "https://one.example/", title: "One", lastActiveAt: 1 },
  {
    tabId: "tab-2",
    position: 1,
    url: "https://two.example/",
    title: "Two",
    private: true,
    openedBy: { kind: "agent" as const, agentId: "root" },
    lastActiveAt: 2,
  },
];

async function database() {
  const home = await mkdtemp(join(tmpdir(), "ace-engine-moves-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const open = () => {
    const store = new Store(join(home, "events.sqlite"));
    onTestFinished(() => store.close());
    return { store, journal: new SqliteEngineMoveJournal((sql) => store.statement(sql)) };
  };
  return open;
}

it("a move's tabs outlive the daemon until the move settles", async () => {
  const open = await database();
  const first = open();
  const thread = createDevThread(first.store, first.store.createWorkspace("/repo", "Repo"));
  first.journal.begin(thread.id, tabs);
  await first.store.close();

  // A restarted daemon reads the move's tabs back as they were, private and opener included.
  const second = open();
  expect(second.journal.pending(thread.id)).toEqual(tabs);
  second.journal.end(thread.id);
  expect(second.journal.pending(thread.id)).toBeUndefined();
});

it("a thread no daemon thread row backs keeps no move", async () => {
  const open = await database();
  const { journal } = open();
  journal.begin("outside-mcp-session", tabs);
  expect(journal.pending("outside-mcp-session")).toBeUndefined();
});
