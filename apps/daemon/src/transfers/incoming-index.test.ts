import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store.ts";
import { IncomingRows, type IncomingRecord } from "./incoming-rows.ts";
import { LiveStarts } from "./live/target-rows.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function open() {
  const root = await mkdtemp(join(tmpdir(), "ace-incoming-"));
  const store = new Store(join(root, "store.sqlite"));
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return store;
}

const record = (transferId: string, state: IncomingRecord["state"]): IncomingRecord => ({
  transferId,
  deviceId: "macbook",
  state,
  method: "remote",
  begin: {
    op: "begin",
    transferId,
    origin: { hostId: "macbook" as never, hostName: "MacBook" },
    method: "remote",
    name: "app",
  },
  updatedAt: 0,
});

describe("the target's transfer rows over time", () => {
  it("never lets retention drop a transfer whose moved thread still has to start", async () => {
    const store = await open();
    const rows = new IncomingRows(store);
    rows.insert(record("pending", "completed"), 1);
    rows.insert(record("finished", "completed"), 1);
    new LiveStarts(store).begin(
      {
        transferId: "pending",
        deviceId: "macbook",
        method: "remote",
        threadId: "n",
        session: { kind: "summary" },
        result: { workspaceId: "w" as never, path: "/srv/app" },
      },
      1,
    );
    // A day and more later, with the target down for all of it.
    const expired = rows.expired(2 * 24 * 60 * 60 * 1000).map((row) => row.transferId);
    expect(expired).toEqual(["finished"]);
  });

  it("recovers open work a home had before its index, after indexing it once in pages", async () => {
    const store = await open();
    // A home from before the index: rows written straight into the table.
    store.atomic((db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS transfer_incoming (
        transfer_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, state TEXT NOT NULL,
        method TEXT NOT NULL, has_origin INTEGER, begin TEXT NOT NULL, commit_input TEXT,
        workspace_id TEXT, registered_id TEXT, created_path TEXT, result TEXT, error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
      const insert = db.prepare(
        "INSERT INTO transfer_incoming (transfer_id,device_id,state,method,begin,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      );
      for (let index = 0; index < 600; index++) {
        const id = `t${String(index).padStart(4, "0")}`;
        insert.run(
          id,
          "macbook",
          index === 599 ? "importing" : "completed",
          "remote",
          JSON.stringify(record(id, "completed").begin),
          index,
          index,
        );
      }
    });
    const rows = new IncomingRows(store);
    await rows.ready();
    expect(rows.unsettled().map((row) => row.transferId)).toEqual(["t0599"]);
    expect(rows.expired(10).map((row) => row.transferId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `t${String(index).padStart(4, "0")}`),
    );
  });

  it("reads open work and expiry without scanning the transfers table (ADR 0170)", async () => {
    const store = await open();
    const rows = new IncomingRows(store);
    await rows.ready();
    const scans: string[] = [];
    // Every statement recovery and retention prepare, with how SQLite plans to run it.
    const statement = store.statement.bind(store);
    store.statement = ((sql: string) => {
      const params = Array.from({ length: sql.split("?").length - 1 }, () => 0);
      const plan = store.atomic((db) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params));
      for (const step of plan)
        if (/^SCAN (transfer_incoming|t)( |$)/.test(String(step["detail"]))) scans.push(sql);
      return statement(sql);
    }) as typeof store.statement;
    rows.unsettled();
    rows.leftovers();
    rows.live();
    rows.expired(1);
    expect(scans).toEqual([]);
  });
});
