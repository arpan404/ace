import { restorePrePreviewSchema } from "./migration-test-support.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { AgentItem } from "@ace/protocol";
import { Store, createDevThread } from "./index.ts";

it("upgrades existing oversized text and appended code units into bounded previews and lazy sources", () => {
  const directory = mkdtempSync(join(tmpdir(), "ace-text-upgrade-"));
  const path = join(directory, "events.sqlite");
  let store: Store | undefined;
  try {
    store = new Store(path);
    const thread = createDevThread(store, store.createWorkspace("/repo", "repo"));
    const item = AgentItem.parse({
      type: "message",
      id: "legacy",
      agentId: "root",
      role: "assistant",
      complete: false,
      createdAt: 0,
      parts: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }],
    });
    store.appendEvents(thread.id, [
      { type: "item.created", item },
      { type: "item.delta", itemId: item.id, agentId: item.agentId, field: "text", append: "😀" },
    ]);
    store.close();
    store = undefined;
    const db = new DatabaseSync(path);
    restorePrePreviewSchema(db);
    // Restore the pre-feature schema with its original authoritative bodies/chunks.
    db.exec("UPDATE schema_version SET version = 5");
    db.close();
    store = new Store(path);
    const page = store.readItemPage(thread.id, store.headSeq() + 1, 1);
    const preview = page.items[0];
    if (preview?.type !== "message") throw new Error("preview");
    const part = preview.parts[0];
    if (part?.type !== "text" || !part.source) throw new Error("source");
    expect(part.text).toBe("x".repeat(4096));
    expect(part.source.bytes).toBe(4 * 1024 * 1024 + 4);
    const result = store.readOutput(part.source.streamId, part.source.bytes - 4, 4);
    expect(Buffer.from(result.bytes, "base64").toString("utf16le")).toBe("😀");
    expect(result.eof).toBe(true);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
