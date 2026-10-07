import { Store } from "@ace/daemon";
import { ThreadId } from "@ace/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { discoverAdapters } from "./adapters.ts";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
const absent: DiscoveryResult = { installed: false, auth: "unknown", loginHint: "fixture" };
it("Cursor discovery selects only the SDK, even when an old client supplies ACP", async () => {
  const registry = await discoverAdapters(
    async () => ({
      claude: absent,
      codex: absent,
      opencode: absent,
      cursor: { ...absent, installed: true },
    }),
    undefined,
    async () => {},
    {},
    async () => ({ installed: true, supported: true, version: "1.0.35" }),
  );
  expect(registry.get("cursor", "acp").adapter.backend).toBe("cursor-sdk");
  const missing = await discoverAdapters(
    async () => ({
      claude: absent,
      codex: absent,
      opencode: absent,
      cursor: { ...absent, installed: true },
    }),
    undefined,
    async () => {},
    {},
    async () => ({ installed: false, supported: false }),
  );
  expect(missing.has("cursor")).toBe(false);
  await registry.close();
  await missing.close();
});

it("opens SDK-only and ACP-only metadata migrations without rewriting the surviving thread identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-acp-schema-"));
  try {
    for (const missing of ["acp", "provider_metadata"] as const) {
      const path = join(home, `${missing}.sqlite`);
      let store = new Store(path);
      const workspaceId = store.createWorkspace(home, "Metadata workspace");
      const threadId = ThreadId.parse(`thread-${missing}`);
      const metadata =
        missing === "acp"
          ? { backend: "cursor-sdk" as const }
          : { acpAgentId: "agent", installationId: "installation", instanceId: "instance" };
      store.appendEvents(
        threadId,
        [
          {
            type: "thread.created",
            thread: {
              id: threadId,
              workspaceId,
              provider: missing === "acp" ? "cursor" : "acp",
              title: "Preserved",
              status: { state: "new" },
              createdAt: 1,
              updatedAt: 1,
              ...metadata,
            },
          },
        ],
        1,
      );
      store.close();
      const db = new DatabaseSync(path);
      try {
        db.exec(`ALTER TABLE threads DROP COLUMN ${missing}`);
      } finally {
        db.close();
      }
      store = new Store(path);
      try {
        expect(store.getThread(threadId)).toMatchObject({ title: "Preserved", ...metadata });
      } finally {
        store.close();
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("upgrades the SDK migration-10 schema without dropping streamed raw data or backend identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-stream-migration-"));
  const path = join(home, "events.sqlite");
  let store = new Store(path);
  try {
    const workspaceId = store.createWorkspace(home, "Workspace");
    const threadId = ThreadId.parse("sdk-thread");
    store.appendEvents(
      threadId,
      [
        {
          type: "thread.created",
          thread: {
            id: threadId,
            workspaceId,
            provider: "cursor",
            title: "SDK history",
            backend: "cursor-sdk",
            status: { state: "new" },
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
      1,
    );
    store.atomic(() => {
      store.appendRawChunk(threadId, {
        id: "raw-before-merge",
        offset: 0,
        text: "preserved SDK evidence",
      });
      store.appendRawChunk(threadId, {
        id: "raw-before-merge",
        offset: Buffer.byteLength("preserved SDK evidence"),
        done: true,
      });
    });
    store.close();
    const db = new DatabaseSync(path);
    try {
      db.exec(`ALTER TABLE threads DROP COLUMN transitions;
        DROP TABLE item_text_targets; DROP TABLE item_source_chunks; DROP TABLE item_text_streams;
        CREATE TABLE item_text_streams (
          id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          part INTEGER NOT NULL, size INTEGER NOT NULL, UNIQUE(item_id,part)
        );
        CREATE TABLE item_source_chunks (
          stream_id TEXT NOT NULL REFERENCES item_text_streams(id) ON DELETE CASCADE,
          offset INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(stream_id,offset)
        );
        UPDATE schema_version SET version=10 WHERE id=1;`);
    } finally {
      db.close();
    }
    store = new Store(path);
    expect(store.getThread(threadId)).toMatchObject({
      title: "SDK history",
      backend: "cursor-sdk",
    });
    expect(Buffer.from(store.readRawChunk("raw-before-merge", 0, 65536)).toString()).toBe(
      "preserved SDK evidence",
    );
    store.appendEvents(
      threadId,
      [
        {
          type: "thread.updated",
          execution: { provider: "cursor", model: "composer-2.5", options: {} },
          capabilities: {
            steer: true,
            interruptCascades: true,
            resume: true,
            fork: true,
            subagentTranscripts: false,
            backgroundTaskControl: false,
            backgroundVisibility: "partial",
            planMode: false,
            tokenUsage: true,
            imageInput: true,
            rewindFiles: false,
          },
        },
      ],
      2,
    );
    store.close();
    store = new Store(path);
    expect(store.getThread(threadId)).toMatchObject({
      backend: "cursor-sdk",
      execution: { provider: "cursor", model: "composer-2.5" },
      capabilities: { resume: true },
    });
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
