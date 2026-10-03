import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { JsonlLocalAgentStore } from "@cursor/sdk";
import { expect, it } from "vitest";
import { snapshotInHost, CursorLimitsSchema } from "./index.ts";

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
