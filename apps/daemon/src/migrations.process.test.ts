import { readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { Agent, Item, type EventPayload } from "@ace/protocol";
import { Store, createDevThread } from "@ace/daemon";

test.each([1, 9, 13])(
  "a daemon database at older schema %s is refused untouched instead of upgraded",
  async (version) => {
    const home = await mkdtemp(join(tmpdir(), "ace-older-schema-"));
    const path = join(home, "events.sqlite");
    try {
      const store = new Store(path);
      const workspaceId = store.createWorkspace(home, "Existing project");
      store.close();
      const db = new DatabaseSync(path);
      db.prepare("UPDATE schema_version SET version=? WHERE id=1").run(version);
      db.close();
      expect(() => new Store(path)).toThrow(
        expect.objectContaining({
          code: "incompatible-data",
          path,
          message: expect.stringContaining(`schema ${version}, and this build reads schema`),
        }),
      );
      const after = new DatabaseSync(path, { readOnly: true });
      try {
        expect(after.prepare("SELECT version FROM schema_version").get()?.version).toBe(version);
        expect(after.prepare("SELECT id FROM workspaces").get()?.id).toBe(workspaceId);
      } finally {
        after.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

const agent = (threadId: string, id: string, parentId: string | null) =>
  Agent.parse({
    id,
    threadId,
    parentId,
    origin: parentId ? "provider_subagent" : "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: "/repo",
    status: { state: "starting" },
    createdAt: 1,
  });
const say = (id: string, agentId: string): EventPayload => ({
  type: "item.created",
  item: Item.parse({
    id,
    agentId,
    type: "message",
    role: id === "ask" ? "user" : "assistant",
    createdAt: 1,
    complete: true,
    parts: [{ type: "text", text: id }],
  }),
});

test("a schema 14 database upgrades in place and its threads keep the root's messages", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-upgrade-14-"));
  const path = join(home, "events.sqlite");
  try {
    const store = new Store(path);
    const thread = createDevThread(store, store.createWorkspace(home, "Existing project"));
    store.appendEvents(thread.id, [
      { type: "agent.created", agent: agent(thread.id, "root", null) },
      { type: "agent.created", agent: agent(thread.id, "sub", "root") },
      say("ask", "root"),
      say("reply", "root"),
      // Subagent output fills the newest rows, so only the root's own rows keep ask/reply.
      ...Array.from({ length: 300 }, (_, n) => say(`step-${n}`, "sub")),
    ]);
    const before = store.snapshotThread(thread.id).itemOrder;
    expect(before.slice(0, 2)).toEqual(["ask", "reply"]);
    store.close();
    // Schema 14 had no per-item agent column, no device expiry and no thread_cold.
    const db = new DatabaseSync(path);
    db.exec(
      "DROP INDEX item_heads_thread_agent; ALTER TABLE item_heads DROP COLUMN agent_id; ALTER TABLE devices DROP COLUMN expires_at; DROP TABLE thread_cold; DROP TRIGGER machine_message_rejections_revoked; DROP TABLE machine_message_rejections; DROP TABLE machine_child_messages; DROP TABLE machine_child_launches; DROP TABLE machine_children; DROP TABLE machine_threads; UPDATE schema_version SET version=14 WHERE id=1",
    );
    db.close();
    const upgraded = new Store(path);
    try {
      expect(upgraded.snapshotThread(thread.id).itemOrder).toEqual(before);
    } finally {
      upgraded.close();
    }
    const after = new DatabaseSync(path, { readOnly: true });
    try {
      expect(after.prepare("SELECT version FROM schema_version").get()?.version).toBe(21);
    } finally {
      after.close();
    }
    // Upgrading never copies the whole database first: that copy blocked startup.
    expect(readdirSync(home).filter((name) => name.includes(".backup"))).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("copies older builds left beside the database are deleted when it opens", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-old-backups-"));
  const path = join(home, "events.sqlite");
  try {
    new Store(path).close();
    await writeFile(`${path}.schema-14.backup`, "old copy");
    await writeFile(`${path}.schema-20.backup`, "old copy");
    // A copy cut short by a crash or a forced quit.
    await writeFile(`${path}.schema-16.backup.partial`, "truncated");
    // Files that only look similar are not ours to delete.
    await writeFile(join(home, "usage.sqlite.schema-14.backup"), "keep");
    await writeFile(join(home, "notes.backup"), "keep");
    new Store(path).close();
    expect(
      readdirSync(home)
        .filter((name) => name.includes("backup"))
        .toSorted(),
    ).toEqual(["notes.backup", "usage.sqlite.schema-14.backup"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
