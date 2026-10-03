import { mkdtemp, realpath, writeFile, readFile, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlLocalAgentStore } from "@cursor/sdk";
import { expect, it } from "vitest";
import { boundedCheckpointStore, openSdkCheckpointStore } from "./index.ts";

it("rejects aggregate growth before committing it and keeps the old checkpoint resumable", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-aggregate-")));
  try {
    const base = new JsonlLocalAgentStore(root);
    await base.checkpoints.create({
      agentId: "agent",
      blobId: "original",
      data: new Uint8Array([1, 2]),
    });
    await writeFile(join(root, "retained.bin"), new Uint8Array(Math.floor(7.9 * 1048576)));
    const prior = await readFile(join(root, "checkpoints.ndjson"));
    let outcome = "";
    const store = boundedCheckpointStore(base, root, 8388608, async () => {
      outcome = "checkpoint budget failed";
    });
    await expect(
      store.checkpoints.create({
        agentId: "agent",
        blobId: "overshoot",
        data: new Uint8Array(1048576),
      }),
    ).rejects.toThrow("aggregate");
    expect(await readFile(join(root, "checkpoints.ndjson"))).toEqual(prior);
    expect(await base.checkpoints.get({ agentId: "agent", blobId: "original" })).toEqual(
      new Uint8Array([1, 2]),
    );
    expect(await base.checkpoints.get({ agentId: "agent", blobId: "overshoot" })).toBeNull();
    expect(outcome).toBe("checkpoint budget failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("serializes concurrent aggregate reservations so only the admitted checkpoint grows the store", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-quota-race-")));
  try {
    const base = new JsonlLocalAgentStore(root);
    await base.checkpoints.create({
      agentId: "agent",
      blobId: "original",
      data: new Uint8Array([1]),
    });
    await writeFile(join(root, "retained.bin"), new Uint8Array(36000));
    const store = boundedCheckpointStore(base, root, 65536, async () => {});
    const outcomes = await Promise.allSettled(
      ["first", "second"].map((blobId) =>
        store.checkpoints.create({ agentId: "agent", blobId, data: new Uint8Array(6000) }),
      ),
    );
    expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "rejected"]);
    expect(await base.checkpoints.get({ agentId: "agent", blobId: "first" })).toEqual(
      new Uint8Array(6000),
    );
    expect(await base.checkpoints.get({ agentId: "agent", blobId: "second" })).toBeNull();
    expect(36000 + (await lstat(join(root, "checkpoints.ndjson"))).size).toBeLessThanOrEqual(65536);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps the native SQLite checkpoint intact when aggregate admission rejects its replacement", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-sqlite-quota-")));
  const owned = await openSdkCheckpointStore({ JsonlLocalAgentStore }, root, root);
  const agentId = "agent",
    blobId = "aa".repeat(32);
  try {
    await owned.store.agents.create({
      agent: { agentId, cwd: root, status: "idle", createdAt: 1, updatedAt: 1 },
    });
    await owned.store.checkpoints.create({ agentId, blobId, data: new Uint8Array([1, 2, 3]) });
    await writeFile(join(root, "retained.bin"), new Uint8Array(7800000));
    const store = boundedCheckpointStore(owned.store, root, 8388608, async () => {});
    await expect(
      store.checkpoints.update({ agentId, blobId, data: new Uint8Array(1048576) }),
    ).rejects.toThrow("aggregate");
    await owned.close();
    const reopened = await openSdkCheckpointStore({ JsonlLocalAgentStore }, root, root);
    try {
      expect(await reopened.store.checkpoints.get({ agentId, blobId })).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await owned.close();
    await rm(root, { recursive: true, force: true });
  }
});
