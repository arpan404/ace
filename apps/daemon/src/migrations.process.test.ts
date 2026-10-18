import { existsSync } from "node:fs";
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
    // Schema 14 had no per-item agent column.
    const db = new DatabaseSync(path);
    db.exec(
      "DROP INDEX item_heads_thread_agent; ALTER TABLE item_heads DROP COLUMN agent_id; UPDATE schema_version SET version=14 WHERE id=1",
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
      expect(after.prepare("SELECT version FROM schema_version").get()?.version).toBe(15);
    } finally {
      after.close();
    }
    // The pre-upgrade copy is kept beside the database and opens at its old version.
    const backup = new DatabaseSync(`${path}.schema-14.backup`, { readOnly: true });
    try {
      expect(backup.prepare("SELECT version FROM schema_version").get()?.version).toBe(14);
      expect(backup.prepare("SELECT COUNT(*) AS n FROM items").get()?.n).toBe(302);
    } finally {
      backup.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a current database opens without writing an upgrade backup", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-current-schema-"));
  const path = join(home, "events.sqlite");
  try {
    new Store(path).close();
    new Store(path).close();
    expect(existsSync(`${path}.schema-15.backup`)).toBe(false);
    expect(existsSync(`${path}.schema-14.backup`)).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an interrupted upgrade backup is redone instead of being kept as the backup", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-upgrade-partial-"));
  const path = join(home, "events.sqlite");
  try {
    const store = new Store(path);
    store.createWorkspace(home, "Existing project");
    store.close();
    const db = new DatabaseSync(path);
    db.exec(
      "DROP INDEX item_heads_thread_agent; ALTER TABLE item_heads DROP COLUMN agent_id; UPDATE schema_version SET version=14 WHERE id=1",
    );
    db.close();
    // A copy cut short by a crash or a full disk.
    await writeFile(`${path}.schema-14.backup.partial`, "truncated");
    new Store(path).close();
    expect(existsSync(`${path}.schema-14.backup.partial`)).toBe(false);
    const backup = new DatabaseSync(`${path}.schema-14.backup`, { readOnly: true });
    try {
      expect(backup.prepare("SELECT version FROM schema_version").get()?.version).toBe(14);
      expect(backup.prepare("SELECT COUNT(*) AS n FROM workspaces").get()?.n).toBe(1);
    } finally {
      backup.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
