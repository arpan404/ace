import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { Agent, Item, type EventPayload } from "@ace/protocol";
import { Store, createDevThread } from "@ace/daemon";
import { readSkillUsage } from "./skill-usage.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function database() {
  const home = await mkdtemp(join(tmpdir(), "ace-skill-usage-"));
  homes.push(home);
  return join(home, "events.sqlite");
}
const root = (threadId: string) =>
  Agent.parse({
    id: "root",
    threadId,
    parentId: null,
    origin: "root",
    native: { provider: "claude" },
    fidelity: "full",
    cwd: "/repo",
    status: { state: "starting" },
    createdAt: 1,
  });
const mention = (name: string, kind: "skill" | "command" = "skill") => ({
  type: "mention" as const,
  entryId: `claude:${kind}:${name}`,
  name,
  kind,
  arguments: "",
});
const message = (
  id: string,
  createdAt: number,
  parts: unknown[],
  extra: Record<string, unknown> = {},
): EventPayload => ({
  type: "item.created",
  item: Item.parse({
    id,
    agentId: "root",
    type: "message",
    role: "user",
    createdAt,
    complete: true,
    parts,
    ...extra,
  }),
});
function seed(store: Store, title: string, events: EventPayload[]) {
  const thread = createDevThread(store, store.createWorkspace(`/repo/${title}`, title), title);
  store.appendEvents(thread.id, [{ type: "agent.created", agent: root(thread.id) }, ...events]);
  return thread;
}

test("skill mentions in people's messages are counted with the latest thread", async () => {
  const store = new Store(await database());
  try {
    const first = seed(store, "first", [
      message("a", 10, [mention("research"), { type: "text", text: "go" }, mention("research")]),
      message("b", 20, [mention("deploy", "command")]),
      message("c", 30, [mention("research")], { synthetic: true }),
    ]);
    const second = seed(store, "second", [message("d", 40, [mention("research"), mention("tdd")])]);
    const usage = readSkillUsage(
      (sql) => store.statement(sql),
      ["research", "tdd", "deploy", "none"],
    );
    expect(usage.get("research")).toMatchObject({
      count: 2,
      last: { threadId: second.id, title: "second", at: 40 },
    });
    expect(usage.get("tdd")).toMatchObject({ count: 1 });
    expect(usage.has("deploy")).toBe(false);
    expect(usage.has("none")).toBe(false);
    store.deleteThread(second.id);
    expect(
      readSkillUsage((sql) => store.statement(sql), ["research"]).get("research"),
    ).toMatchObject({
      count: 1,
      last: { threadId: first.id, at: 10 },
    });
  } finally {
    store.close();
  }
});

test("upgrading counts skill mentions already in the history once", async () => {
  const path = await database();
  const store = new Store(path);
  seed(store, "old", [
    message("a", 10, [mention("research")]),
    message("b", 20, [mention("research"), mention("unslop")]),
  ]);
  store.close();
  // The previous schema had no usage table.
  const db = new DatabaseSync(path);
  db.exec(
    "DROP TABLE skill_usage; DROP TABLE machine_message_rejections; DROP TABLE machine_child_messages; DROP TABLE machine_child_launches; DROP TABLE machine_children; DROP TABLE machine_threads; UPDATE schema_version SET version=17 WHERE id=1",
  );
  db.close();
  const upgraded = new Store(path);
  try {
    const usage = readSkillUsage((sql) => upgraded.statement(sql), ["research", "unslop"]);
    expect(usage.get("research")?.count).toBe(2);
    expect(usage.get("unslop")).toMatchObject({ count: 1, last: { at: 20 } });
  } finally {
    upgraded.close();
  }
});
