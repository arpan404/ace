import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CommandId, HostId, ThreadId, Transfer, WorkspaceId } from "@ace/protocol";
import { Store } from "../store.ts";
import { OutgoingRows } from "./outgoing-rows.ts";
import { OutgoingTransfers, type OutgoingDeps } from "./outgoing.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("carries every unsettled transfer on after a restart, and keeps all their payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-outgoing-recovery-"));
  const directory = join(root, "outgoing");
  await mkdir(directory, { recursive: true });
  const store = new Store(join(root, "store.sqlite"));
  const rows = new OutgoingRows(store);
  const ids = Array.from(
    { length: 70 },
    (_, index) => `transfer-${String(index).padStart(3, "0")}`,
  );
  for (const transferId of ids) {
    const transfer: Transfer = {
      transferId,
      commandId: `c-${transferId}` as CommandId,
      kind: "project",
      workspaceId: "w" as WorkspaceId,
      target: { hostId: "studio" as HostId, name: "Studio" },
      phase: "sending",
      method: "bundle",
      sentBytes: 0,
      startedAt: 0,
      updatedAt: 0,
    };
    rows.insert({
      transfer,
      request: {
        hostId: "studio" as HostId,
        profile: "studio",
        includeChanges: true,
        includeIgnored: false,
        live: false,
      },
      plan: { source: root, name: "app" },
      delivered: true,
    });
    await writeFile(join(directory, `${transferId}.bundle`), "bytes");
  }
  await writeFile(join(directory, "transfer-gone.bundle"), "left by a crash");
  const asked = new Set<string>();
  const outgoing = new OutgoingTransfers({
    store,
    directory,
    profiles: () => [{ name: "studio", hostId: "studio" }],
    // The other machine never answers: every transfer stays unsettled, its payload wanted.
    transport: (_profile: unknown, route: { body: Buffer | string }) => {
      asked.add(String(JSON.parse(String(route.body)).transferId));
      return new Promise(() => {});
    },
    origin: async () => ({ hostId: "macbook" as HostId, hostName: "MacBook" }),
    now: () => 0,
    sleep: async () => {},
    nextId: () => "id",
    log: () => {},
  } as unknown as OutgoingDeps);
  cleanups.push(async () => {
    await Promise.race([outgoing.close(), new Promise((resolve) => setTimeout(resolve, 50))]);
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await outgoing.recover();
  await expect.poll(() => asked.size).toBe(ids.length);
  const left = await readdir(directory);
  expect(left.toSorted()).toEqual(ids.map((id) => `${id}.bundle`));
});

it("reads recovery's work and retention's oldest rows from side tables, never all of history", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-outgoing-plan-"));
  const store = new Store(join(root, "store.sqlite"));
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const rows = new OutgoingRows(store);
  await rows.ready();
  const scans: string[] = [];
  const statement = store.statement.bind(store);
  store.statement = ((sql: string) => {
    const params = Array.from({ length: sql.split("?").length - 1 }, () => 0);
    const plan = store.atomic((db) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params));
    // Each read starts from a side table (`o`, `e`), never from the transfers table itself: a
    // walk of its primary key reads every transfer ever sent, even when SQLite calls it a search.
    const first = String(plan[0]?.["detail"] ?? "");
    if (!/^(SCAN|SEARCH) (o|e)( |$)/.test(first)) scans.push(`${first}: ${sql}`);
    return statement(sql);
  }) as typeof store.statement;
  rows.unsettled();
  rows.undelivered();
  rows.expired(1);
  rows.movingThread("t");
  expect(scans).toEqual([]);
});

it("starts no second move of a thread while an upgraded home's transfers are still indexed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-outgoing-upgrade-"));
  const directory = join(root, "outgoing");
  await mkdir(directory, { recursive: true });
  const store = new Store(join(root, "store.sqlite"));
  // A home from before the side tables, with the thread's move under way.
  const moving: Transfer = {
    transferId: "transfer-old",
    commandId: "c-old" as CommandId,
    kind: "thread",
    threadId: "t-1" as ThreadId,
    workspaceId: "w" as WorkspaceId,
    target: { hostId: "studio" as HostId, name: "Studio" },
    phase: "sending",
    method: "bundle",
    sentBytes: 0,
    startedAt: 0,
    updatedAt: 0,
  };
  const request = {
    hostId: "studio" as HostId,
    profile: "studio",
    includeChanges: true,
    includeIgnored: false,
    live: true,
  };
  store.atomic((db) => {
    db.exec(`CREATE TABLE transfer_outgoing (
      transfer_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, phase TEXT NOT NULL,
      record TEXT NOT NULL, request TEXT NOT NULL, plan TEXT,
      delivered INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL)`);
    db.prepare(
      "INSERT INTO transfer_outgoing VALUES ('transfer-old', 'c-old', 'sending', ?, ?, NULL, 1, 0, 0)",
    ).run(JSON.stringify(moving), JSON.stringify(request));
  });
  const outgoing = new OutgoingTransfers({
    store,
    directory,
    profiles: () => [{ name: "studio", hostId: "studio" }],
    // The other machine takes transfers and never answers anything else.
    transport: (_profile: unknown, route: { body: Buffer | string }) =>
      JSON.parse(String(route.body)).op === "probe"
        ? Promise.resolve({ hostId: "studio", name: "Studio", accepts: true })
        : new Promise(() => {}),
    origin: async () => ({ hostId: "macbook" as HostId, hostName: "MacBook" }),
    now: () => 0,
    sleep: async () => {},
    nextId: () => "new",
    log: () => {},
  } as unknown as OutgoingDeps);
  cleanups.push(async () => {
    await Promise.race([outgoing.close(), new Promise((resolve) => setTimeout(resolve, 50))]);
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const start = (id: string) =>
    outgoing.start({
      commandId: id as CommandId,
      kind: "thread",
      workspaceId: "w" as WorkspaceId,
      threadId: "t-1" as ThreadId,
      source: root,
      name: "app",
      request,
      target: { hostId: "studio" as HostId, name: "Studio" },
    });
  await expect(start("c-early")).rejects.toMatchObject({ code: "transfers_unavailable" });
  await new OutgoingRows(store).ready();
  await expect(start("c-later")).rejects.toMatchObject({ code: "thread_moving" });
});

it("never sends a transfer to another machine linked under its target's old name", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-outgoing-relinked-"));
  const directory = join(root, "outgoing");
  await mkdir(directory, { recursive: true });
  const store = new Store(join(root, "store.sqlite"));
  const rows = new OutgoingRows(store);
  // Studio took the commit, but its answer was lost: the transfer is importing there.
  const transfer: Transfer = {
    transferId: "transfer-lost",
    commandId: "c-lost" as CommandId,
    kind: "thread",
    threadId: "t-1" as ThreadId,
    workspaceId: "w" as WorkspaceId,
    target: { hostId: "studio" as HostId, name: "Studio" },
    phase: "importing",
    method: "bundle",
    sentBytes: 5,
    totalBytes: 5,
    startedAt: 0,
    updatedAt: 0,
  };
  rows.insert({
    transfer,
    request: {
      hostId: "studio" as HostId,
      profile: "studio",
      includeChanges: true,
      includeIgnored: false,
      live: false,
    },
    plan: { source: root, name: "app" },
    delivered: true,
  });
  // The person unlinked Studio and linked another machine under the free name `studio`, and
  // an old link with no host id kept, which says it is yet another machine.
  let profiles: { name: string; hostId?: string }[] = [
    { name: "studio", hostId: "mini" },
    { name: "laptop" },
  ];
  const asked: string[] = [];
  const outgoing = new OutgoingTransfers({
    store,
    directory,
    profiles: () => profiles,
    transport: (profile: { name: string; hostId?: string }, route: { body: Buffer | string }) => {
      const call = JSON.parse(String(route.body));
      if (call.op === "probe")
        return Promise.resolve({ hostId: profile.hostId ?? "laptop", name: "x", accepts: true });
      asked.push(`${profile.hostId ?? profile.name}:${call.op}`);
      return Promise.resolve({
        transferId: "transfer-lost",
        state: "importing",
        method: "bundle",
        offset: 0,
      });
    },
    origin: async () => ({ hostId: "macbook" as HostId, hostName: "MacBook" }),
    now: () => 0,
    sleep: (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      }),
    nextId: () => "id",
    log: () => {},
  } as unknown as OutgoingDeps);
  cleanups.push(async () => {
    await Promise.race([outgoing.close(), new Promise((resolve) => setTimeout(resolve, 50))]);
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await outgoing.recover();
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Nothing reached either other machine, and the transfer waits for Studio, unsettled.
  expect(asked).toEqual([]);
  expect(outgoing.get("transfer-lost")?.transfer.phase).toBe("importing");
  // A cancel is never answered by another machine either: it stays unconfirmed.
  await expect(outgoing.cancel("transfer-lost")).rejects.toMatchObject({
    code: "cancel_unconfirmed",
  });
  expect(asked).toEqual([]);
  // Studio linked again, under any name: the transfer carries on there.
  profiles = [...profiles, { name: "studio-2", hostId: "studio" }];
  await expect.poll(() => asked.some((call) => call.startsWith("studio:"))).toBe(true);
  expect(asked.filter((call) => !call.startsWith("studio:"))).toEqual([]);
});
