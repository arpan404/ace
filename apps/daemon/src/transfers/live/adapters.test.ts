import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ServiceContext } from "../../services/types.ts";
import { Store } from "../../store.ts";
import type { TransferArchive, TransferGit } from "../ports.ts";
import { liveSourcePorts } from "./adapters.ts";
import { ThreadOwnership } from "./ownership.ts";
import type { LiveResumes } from "./resumes.ts";

/*
 * The move's read of the tree's children on other machines (ADR 0191), against a real store:
 * which ones still hold the thread here.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function source() {
  const root = await mkdtemp(join(tmpdir(), "ace-live-adapters-"));
  const store = new Store(join(root, "store.sqlite"));
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  // No engine or agent control: the tree is the thread itself.
  const context = { store, services: {}, now: () => 1_000 } as unknown as ServiceContext;
  const ports = liveSourcePorts(context, {
    ownership: new ThreadOwnership(store),
    git: {} as TransferGit,
    archive: {} as TransferArchive,
    resumes: {} as LiveResumes,
    sleep: async () => {},
  });
  let next = 0;
  const child = (role: string, row: { settled?: number; stoppedUnconfirmed?: number }) =>
    store
      .statement(
        `INSERT INTO machine_children (id, request_key, parent_thread, parent_agent, machine, role,
          provider, created_at, settled, settled_at, stopped_unconfirmed)
          VALUES (?, ?, 't', 'a', 'elsewhere', ?, 'claude', 1, ?, ?, ?)`,
      )
      .run(
        `c-${++next}`,
        `k-${next}`,
        role,
        row.settled ?? 0,
        row.settled ? 5 : null,
        row.stoppedUnconfirmed ?? 0,
      );
  return { ports, child };
}

it("still counts a child whose stop went unconfirmed in an earlier attempt", async () => {
  const { ports, child } = await source();
  // Settled unconfirmed at 5, long before this attempt; its machine never answered since.
  child("reviewer", { settled: 1, stoppedUnconfirmed: 1 });
  child("gone", { settled: 1, stoppedUnconfirmed: 3 });
  child("answered-late", { settled: 1, stoppedUnconfirmed: 2 });
  expect(ports.remoteChildren("t")).toEqual({ running: [], unconfirmed: ["reviewer", "gone"] });
});

it("finds the unconfirmed child behind many confirmed ones", async () => {
  const { ports, child } = await source();
  for (let index = 0; index < 100; index++) child(`done-${index}`, { settled: 1 });
  child("reviewer", { settled: 1, stoppedUnconfirmed: 1 });
  child("tests", {});
  expect(ports.remoteChildren("t")).toEqual({ running: ["tests"], unconfirmed: ["reviewer"] });
});
