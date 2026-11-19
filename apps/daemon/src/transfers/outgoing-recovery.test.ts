import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CommandId, HostId, Transfer, WorkspaceId } from "@ace/protocol";
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
