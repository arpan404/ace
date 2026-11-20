import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunId, type Device, type TransferCommit } from "@ace/protocol";
import { Store } from "../store.ts";
import { IncomingRows, type IncomingRecord } from "./incoming-rows.ts";
import { IncomingTransfers, type IncomingDeps } from "./incoming.ts";
import { ThreadOwnership } from "./live/ownership.ts";
import { LiveTarget, type LiveTargetPorts } from "./live/target.ts";
import { LiveStarts } from "./live/target-rows.ts";
import { incomingPath } from "./incoming-files.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const device = { id: "macbook", name: "MacBook" } as unknown as Device;
const result = { workspaceId: "w" as never, path: "/srv/app", threadId: "n" as never };
const live = {
  epoch: 1,
  sourceThreadId: "t" as never,
  left: { shells: [], children: [], remoteChildren: [], queued: 0 },
  unsupported: "nothing to carry",
} satisfies NonNullable<TransferCommit["live"]>;

const record = (transferId: string, change: Partial<IncomingRecord> = {}): IncomingRecord => ({
  transferId,
  deviceId: device.id,
  state: "importing",
  method: "remote",
  begin: {
    op: "begin",
    transferId,
    origin: { hostId: "macbook" as never, hostName: "MacBook" },
    method: "remote",
    name: "app",
    live: true,
  },
  updatedAt: 0,
  ...change,
});

/** A target with a real store and folder; its projects, threads and Git are the edges faked. */
async function target(options: { setUp?: () => void; threadStatus?: () => never } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ace-incoming-recovery-"));
  const directory = join(root, "incoming");
  await mkdir(directory, { recursive: true });
  const store = new Store(join(root, "store.sqlite"));
  const ports: LiveTargetPorts = {
    starts: new LiveStarts(store),
    ownership: new ThreadOwnership(store),
    git: { fetchBundle: async () => {}, deleteRef: async () => {} },
    archive: { unpackArchive: async () => ({ entries: 0 }) },
    account: () => undefined,
    threadCwd: () => "/srv/app",
    threadStatus: options.threadStatus ?? (() => ({ state: "working", agents: 1 }) as const),
    continueFate: () => ({
      fate: { state: "delivered", runId: RunId.parse("run-1") },
      held: false,
    }),
    adoptSession: () => {},
    dropSession: () => {},
    adoptHandoff: () => {},
    send: () => {},
    retryHeld: () => {},
    atomic: (run) => store.atomic(run),
    notice: () => {},
    now: () => 0,
    sleep: async () => {},
    log: () => {},
  };
  const deps = {
    store,
    directory,
    git: {},
    archive: {},
    projects: { list: () => [] },
    threads: {
      create: async () => {
        throw new Error("not made here");
      },
      setUp: (_input: unknown, then: () => void) => {
        options.setUp?.();
        then();
      },
    },
    live: new LiveTarget(ports),
    now: () => 0,
    // A turn of the event loop, as a real timer gives, so retries never starve the rest.
    sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
    log: () => {},
  } as unknown as IncomingDeps;
  const incoming = new IncomingTransfers(deps);
  cleanups.push(async () => {
    await incoming.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { incoming, store, directory, rows: new IncomingRows(store) };
}

const thread = {
  sourceThreadId: "t" as never,
  title: "Login bug",
  mode: "local" as const,
  provider: "claude" as const,
  handoff: {
    version: 1 as const,
    sourceThreadId: "t" as never,
    throughSeq: 0,
    lossy: true as const,
    policy: "conversation-first" as const,
    excerpts: [],
    omittedItems: 0,
    history: {
      type: "items.page" as const,
      tool: "handoff_read" as const,
      threadId: "t" as never,
      before: 1,
      limit: 50 as const,
    },
    limitations:
      "Provider-private state is unavailable. Page history for omitted items, full text, reasoning, tools and attachments." as const,
  },
};

describe("a target's recovery after a restart", () => {
  it("never completes a transfer without its setup, however long the setup keeps failing", async () => {
    const t = await target({
      setUp: () => {
        throw new Error("disk full");
      },
    });
    t.rows.insert(record("x"), 0);
    t.rows.update("x", { commit: { op: "commit", transferId: "x", live, thread }, result }, 0);
    await t.incoming.recover();
    // Well past any number of tries: the thread there has no handoff or link back yet, so the
    // sender is still told it is importing, never that it completed.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await t.incoming.call(device, { op: "status", transferId: "x" })).toMatchObject({
      state: "importing",
    });
  });

  it("completes and starts the thread once a failing setup goes through", async () => {
    let failures = 3;
    const t = await target({
      setUp: () => {
        if (failures-- > 0) throw new Error("busy");
      },
    });
    t.rows.insert(record("x"), 0);
    t.rows.update("x", { commit: { op: "commit", transferId: "x", live, thread }, result }, 0);
    await t.incoming.recover();
    await expect
      .poll(() => t.incoming.call(device, { op: "status", transferId: "x" }))
      .toMatchObject({ state: "completed", live: { running: true } });
  });

  it("answers the sender when its moved thread's start keeps throwing", async () => {
    const t = await target({
      threadStatus: () => {
        throw new Error("store unreadable");
      },
    });
    t.rows.insert(record("x"), 0);
    t.rows.update("x", { commit: { op: "commit", transferId: "x", live, thread }, result }, 0);
    await t.incoming.recover();
    await expect
      .poll(() => t.incoming.call(device, { op: "status", transferId: "x" }))
      .toMatchObject({
        state: "completed",
        live: { running: false },
      });
  });

  it("finishes every import a restart left, past one batch", async () => {
    const t = await target();
    const ids = Array.from({ length: 70 }, (_, index) => `x${String(index).padStart(3, "0")}`);
    for (const id of ids) {
      t.rows.insert(record(id, { begin: { ...record(id).begin, live: undefined } }), 0);
      t.rows.update(id, { commit: { op: "commit", transferId: id }, result }, 0);
    }
    await t.incoming.recover();
    expect(ids.filter((id) => t.rows.get(id)?.state !== "completed")).toEqual([]);
  });

  it("keeps every live transfer's payload, however many there are, and cancels those under old names", async () => {
    const t = await target();
    const ids = Array.from({ length: 1_100 }, (_, index) => `r${String(index).padStart(4, "0")}`);
    // Every tenth upload is still under the name an earlier build gave it, the id itself.
    const old = ids.filter((_, index) => index % 10 === 0);
    for (const id of ids) {
      t.rows.insert(record(id, { state: "receiving" }), 0);
      const name = old.includes(id)
        ? `${id}.part`
        : basename(incomingPath(t.directory, id, "code"));
      await writeFile(join(t.directory, name), "bytes");
    }
    await writeFile(join(t.directory, "gone.part"), "left by a crash");
    await t.incoming.recover();
    // The rest are kept under their own names, nothing else is left, and each resumes in place.
    const kept = ids.filter((id) => !old.includes(id));
    expect((await readdir(t.directory)).toSorted()).toEqual(
      kept.map((id) => basename(incomingPath(t.directory, id, "code"))).toSorted(),
    );
    for (const id of [kept[0], kept[700], kept.at(-1)].filter((each) => each !== undefined))
      await expect(
        t.incoming.call(device, { op: "status", transferId: id }),
      ).resolves.toMatchObject({ state: "receiving", offset: "bytes".length });
    // Those under old names are cancelled, so their senders start them again.
    expect(old.filter((id) => t.rows.get(id)?.state !== "cancelled")).toEqual([]);
  });
});
