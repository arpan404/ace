import { readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { expect, test } from "vitest";
import { pairingLinkProof } from "@ace/client/link-proof";
import { Agent, DeviceId, InstallId, Item, type EventPayload } from "@ace/protocol";
import { Store, createDevThread } from "@ace/daemon";
import { schemaVersion } from "./migrations.ts";

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

/**
 * What the ADR 0115 steps (the last two) added: the devices' install and fold columns, and the
 * account link column. Taken out so a fixture is the older schema it says it is.
 */
const undoInstalls =
  "DROP INDEX devices_install; ALTER TABLE devices DROP COLUMN account_link; ALTER TABLE devices DROP COLUMN merged_into; ALTER TABLE devices DROP COLUMN install_id;";
/** The schema just before the ADR 0115 steps. */
const beforeInstalls = schemaVersion - 2;
/** The machine code tables (ADR 0111, the step before those) and everything after them. */
const undoMachineCodeAndInstalls =
  "DROP TABLE machine_code; DROP TABLE machine_code_passes; " + undoInstalls;

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
    // Schema 14 had no per-item agent column, no device expiry, no thread_cold, no machine code
    // and no install ids.
    const db = new DatabaseSync(path);
    db.exec(
      // Newest steps first: dropping a column rechecks triggers on tables already gone.
      undoMachineCodeAndInstalls +
        " DROP INDEX item_heads_thread_agent; ALTER TABLE item_heads DROP COLUMN agent_id; ALTER TABLE devices DROP COLUMN expires_at; DROP TABLE thread_cold; DROP TRIGGER machine_message_rejections_revoked; DROP TABLE machine_message_rejections; DROP TABLE machine_child_messages; DROP TABLE machine_child_launches; DROP TABLE machine_children; DROP TABLE machine_threads; UPDATE schema_version SET version=14 WHERE id=1",
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
      expect(after.prepare("SELECT version FROM schema_version").get()?.version).toBe(
        schemaVersion,
      );
    } finally {
      after.close();
    }
    // Upgrading never copies the whole database first: that copy blocked startup.
    expect(readdirSync(home).filter((name) => name.includes(".backup"))).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a thread an agent opened before startedBy existed names its starter after the upgrade", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-upgrade-started-by-"));
  const path = join(home, "events.sqlite");
  try {
    const store = new Store(path);
    const workspace = store.createWorkspace(home, "Existing project");
    const starter = createDevThread(store, workspace);
    const started = createDevThread(store, workspace);
    const person = createDevThread(store, workspace);
    store.close();
    // Schema 23 recorded thread_start's caller only in the conversation journal.
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO agent_conversations VALUES (?,?,?,?,?,?)").run(
      started.id,
      starter.id,
      "root",
      starter.id,
      "request-1",
      "{}",
    );
    // The remote-child liveness step came after, so its columns go too.
    db.exec(
      "DROP INDEX machine_children_seen; DROP INDEX machine_children_stopping; ALTER TABLE machine_children DROP COLUMN seen_at; ALTER TABLE machine_children DROP COLUMN silent_since; ALTER TABLE machine_children DROP COLUMN stop_started_at; ALTER TABLE machine_children DROP COLUMN stop_attempts; ALTER TABLE machine_children DROP COLUMN stop_last_at; ALTER TABLE machine_children DROP COLUMN stopped_unconfirmed; " +
        undoMachineCodeAndInstalls +
        " UPDATE schema_version SET version=23 WHERE id=1",
    );
    db.close();
    const upgraded = new Store(path);
    try {
      expect(upgraded.getThread(started.id)?.startedBy).toBe(starter.id);
      expect(upgraded.getThread(person.id)?.startedBy).toBeUndefined();
    } finally {
      upgraded.close();
    }
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

test("paired devices keep working credentials through the upgrade to install ids and every reopen after it", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-upgrade-installs-"));
  const path = join(home, "events.sqlite");
  try {
    const store = new Store(path);
    const phone = store.devices.create("Phone", ["read", "operate"], 1000);
    const tablet = store.devices.create("Tablet", ["read"], 1000, 5000);
    store.close();
    // The release before installs had ids: no install, fold or account link columns.
    const db = new DatabaseSync(path);
    db.exec(`${undoInstalls} UPDATE schema_version SET version=${beforeInstalls} WHERE id=1`);
    db.close();

    for (let open = 0; open < 2; open++) {
      const reopened = new Store(path);
      try {
        expect(reopened.devices.authenticate(phone.token, 2000)).toMatchObject({
          id: phone.device.id,
          scopes: ["read", "operate"],
        });
        expect(reopened.devices.authenticate(tablet.token, 2000)).toMatchObject({
          id: tablet.device.id,
          expiresAt: 5000,
        });
        expect(reopened.devices.list().map((device) => device.id)).toEqual([
          phone.device.id,
          tablet.device.id,
        ]);
        // Nothing older is linked to an account device: that takes a proof.
        expect(reopened.devices.sameInstall(phone.device.id, tablet.device.id)).toBe(false);
      } finally {
        reopened.close();
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a populated schema 28 database keeps credentials, install ids and folded records through the account link upgrade", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-upgrade-account-link-"));
  const path = join(home, "events.sqlite");
  const install = InstallId.parse("01936d1e-3f8a-7c2b-9d4e-5f6a7b8c9d0e");
  try {
    const store = new Store(path);
    // A record the install left before it had an id, then the install pairing again.
    const left = store.devices.create("Phone", ["read"], 1000);
    const phone = store.devices.create("Phone", ["read", "operate"], 1100, null, install);
    store.devices.recognize(phone.device.id, install, 1200);
    expect(store.devices.list().map((device) => device.id)).toEqual([phone.device.id]);
    store.close();
    // The release before account links: schema 28, with installs and folds but no link column.
    const db = new DatabaseSync(path);
    db.exec(
      `ALTER TABLE devices DROP COLUMN account_link; UPDATE schema_version SET version=${schemaVersion - 1} WHERE id=1`,
    );
    db.close();

    const reopened = new Store(path);
    try {
      expect(reopened.devices.authenticate(phone.token, 2000)).toMatchObject({
        id: phone.device.id,
        scopes: ["read", "operate"],
      });
      expect(reopened.devices.heldBy(install, 2000)).toBe(phone.device.id);
      // The folded record stays under the install's record and comes back when it is used.
      expect(reopened.devices.list().map((device) => device.id)).toEqual([phone.device.id]);
      expect(reopened.devices.authenticate(left.token, 2000)).toMatchObject({ id: left.device.id });
      // Nothing is linked by the upgrade; a proof made with the current credential links.
      const account = DeviceId.parse(install);
      expect(reopened.sameDevice(phone.device.id, account)).toBe(false);
      expect(
        reopened.devices.link(
          account,
          await pairingLinkProof(phone.token, phone.device.id, account, crypto.subtle),
          2000,
        ),
      ).toBe(true);
      expect(reopened.sameDevice(phone.device.id, account)).toBe(true);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
