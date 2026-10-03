import { Store } from "@ace/daemon";
import { ThreadId } from "@ace/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { AdapterRegistry } from "./registry.ts";
import { migrateEngine } from "./migrations.ts";
import { createCursorAdapter } from "@ace/adapter-cursor";
import { createAcpAdapter, cursorQuirks } from "@ace/adapter-acp";
import { discoverAdapters } from "./adapters.ts";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import { engineSchemaVersion } from "./schema-version.ts";
const absent: DiscoveryResult = { installed: false, auth: "unknown", loginHint: "fixture" };
it("selects SDK for CLI-free new threads and retains ACP for pinned old threads", async () => {
  const discover = async () => ({
    claude: absent,
    codex: absent,
    opencode: absent,
    cursor: absent,
  });
  const registry = await discoverAdapters(
    discover,
    undefined,
    async () => {},
    {},
    async () => ({
      installed: true,
      supported: true,
      version: "1.0.35",
    }),
  );
  expect(registry.get("cursor").capabilities.approvals).toBe("sandbox-only");
  expect(() => registry.get("cursor", "acp")).toThrow("original runtime");
  const cli = { ...absent, installed: true };
  const fallback = await discoverAdapters(
    async () => ({ ...(await discover()), cursor: cli }),
    undefined,
    async () => {},
    {},
    async () => ({ installed: false, supported: false }),
  );
  expect(fallback.get("cursor").capabilities.approvals).toBeUndefined();
  expect(fallback.get("cursor", "acp").adapter.provider).toBe("cursor");
  const unsupported = await discoverAdapters(
    async () => ({ ...(await discover()), cursor: cli }),
    undefined,
    async () => {},
    {},
    async () => ({
      installed: true,
      supported: false,
      version: "future",
      error: "unsupported SDK",
    }),
  );
  expect(unsupported.get("cursor").capabilities.approvals).toBe("sandbox-only");
  await Promise.all([registry.close(), fallback.close(), unsupported.close()]);
});
it("preserves pre-SDK session identity during the additive metadata migration", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-metadata-"));
  const db = new DatabaseSync(join(home, "state.sqlite"));
  try {
    db.exec(
      `CREATE TABLE engine_schema_version(id INTEGER PRIMARY KEY, version INTEGER); CREATE TABLE workspaces(id TEXT PRIMARY KEY,path TEXT); CREATE TABLE threads(id TEXT PRIMARY KEY,workspace_id TEXT,client JSON); CREATE TABLE engine_sessions(thread_id TEXT PRIMARY KEY,cwd TEXT,model TEXT,native_session_id TEXT); INSERT INTO workspaces VALUES ('workspace','/fixture'); INSERT INTO threads VALUES ('old','workspace','{}'); INSERT INTO engine_sessions VALUES ('old','/fixture','model','acp-native-id')`,
    );
    db.prepare("INSERT INTO engine_schema_version VALUES (1,?)").run(engineSchemaVersion);
    migrateEngine(db);
    const row = db.prepare("SELECT * FROM engine_sessions WHERE thread_id='old'").get();
    expect(row).toMatchObject({
      native_session_id: "acp-native-id",
      backend: null,
      instance_id: null,
    });
    const registry = new AdapterRegistry();
    registry.registerFallback(
      createAcpAdapter(cursorQuirks),
      { ...absent, installed: true },
      "acp",
    );
    registry.register(createCursorAdapter(), absent);
    expect(registry.get("cursor", "acp").capabilities).not.toEqual(
      registry.get("cursor").capabilities,
    );
    await registry.close();
  } finally {
    db.close();
    await rm(home, { recursive: true, force: true });
  }
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
