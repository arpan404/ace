import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { JsonlLocalAgentStore } from "@cursor/sdk";
import { expect, it } from "vitest";
import { snapshotInHost, CursorLimitsSchema, openSdkCheckpointStore } from "./index.ts";

it("verifies native SDK history identities without materializing protobuf message content", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-native-history-")));
  const threadId = "native-history";
  const agentId = "native-agent";
  const root = join(
    home,
    ".cursor",
    "sdk",
    "ace",
    createHash("sha256").update(threadId).digest("hex"),
  );
  const blobId = "ab".repeat(32);
  try {
    const owned = await openSdkCheckpointStore({ JsonlLocalAgentStore }, root, home);
    try {
      await owned.store.agents.create({
        agent: {
          agentId,
          cwd: home,
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
          latestCheckpoint: { schemaVersion: 1, rootBlobId: blobId },
        },
      });
      await owned.store.checkpoints.create({ agentId, blobId, data: new Uint8Array([1, 2, 3]) });
    } finally {
      await owned.close();
    }
    const message = {
      uuid: `${agentId}:0`,
      agent_id: agentId,
      type: "assistant",
      get message() {
        throw new Error("Native conversation content must not be inspected");
      },
    };
    const sdk = {
      JsonlLocalAgentStore,
      Agent: {
        messages: {
          async list() {
            return [message];
          },
        },
      },
    };
    const result = await snapshotInHost(
      sdk,
      { threadId, agentId, cwd: home, limits: CursorLimitsSchema.parse({ maxFrameBytes: 4096 }) },
      home,
    );
    expect(result.items).toEqual([{ uuid: `${agentId}:0`, agent_id: agentId, type: "assistant" }]);
    const bad = {
      JsonlLocalAgentStore,
      Agent: {
        messages: {
          async list() {
            return [{ uuid: `${agentId}:1`, agent_id: agentId, type: "assistant" }];
          },
        },
      },
    };
    await expect(
      snapshotInHost(
        bad,
        { threadId, agentId, cwd: home, limits: CursorLimitsSchema.parse({}) },
        home,
      ),
    ).rejects.toThrow("position/agent identity");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("refuses oversized checkpoints before the SDK can materialize the conversation", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-history-")));
  try {
    const threadId = "oversized-history";
    const root = join(
      home,
      ".cursor",
      "sdk",
      "ace",
      createHash("sha256").update(threadId).digest("hex"),
    );
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "checkpoints.ndjson"), "x".repeat(2048));
    const sdk = {
      JsonlLocalAgentStore,
      Agent: {
        messages: {
          async list() {
            throw new Error("Unsafe full-conversation materialization reached provider boundary");
          },
        },
      },
    };
    await expect(
      snapshotInHost(
        sdk,
        {
          threadId,
          agentId: "native-agent",
          limits: CursorLimitsSchema.parse({ maxCheckpointBytes: 1024 }),
        },
        home,
      ),
    ).rejects.toThrow("exceeds recovery budget");
    await expect(
      snapshotInHost(
        sdk,
        {
          threadId,
          agentId: "bc-cloud-agent",
          limits: CursorLimitsSchema.parse({}),
        },
        home,
      ),
    ).rejects.toThrow("Cloud snapshots are forbidden");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("refuses native continuation with only agent metadata and no SDK conversation checkpoint", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-missing-checkpoint-")));
  try {
    const threadId = "missing-state";
    const root = join(
      home,
      ".cursor",
      "sdk",
      "ace",
      createHash("sha256").update(threadId).digest("hex"),
    );
    const store = new JsonlLocalAgentStore(root);
    await store.agents.create({
      agent: { agentId: "native-agent", cwd: home, status: "idle", createdAt: 1, updatedAt: 1 },
    });
    await expect(
      snapshotInHost(
        {
          JsonlLocalAgentStore,
          Agent: {
            messages: {
              async list() {
                return [];
              },
            },
          },
        },
        {
          threadId,
          agentId: "native-agent",
          cwd: home,
          limits: CursorLimitsSchema.parse({}),
        },
        home,
      ),
    ).rejects.toThrow("native conversation checkpoint is missing");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
