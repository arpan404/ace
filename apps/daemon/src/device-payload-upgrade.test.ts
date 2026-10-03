import { restorePrePreviewSchema } from "./migration-test-support.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store, createDevThread } from "./index.ts";
import { message, shell } from "./payload-test-support.ts";

it("preserves main's version-two paired devices when adding payload storage", () => {
  const home = mkdtempSync(join(tmpdir(), "ace-device-payload-upgrade-"));
  const path = join(home, "events.sqlite");
  let store = new Store(path);
  try {
    const paired = store.devices.create("Phone", ["read"], 1000);
    const thread = createDevThread(store, store.createWorkspace("/repo", "repo"));
    store.close();
    const db = new DatabaseSync(path);
    restorePrePreviewSchema(db);
    db.exec(`DROP TABLE text_encoding_migration; DROP TABLE status_migration;
      DROP TABLE view_entities; DROP TABLE item_text_chunks; DROP TABLE item_heads;
      DROP TABLE items; DROP TABLE output_chunks; DROP TABLE output_streams;
      DROP TABLE blobs; DROP TABLE host_sequence; DROP TABLE payload_migration;
      UPDATE schema_version SET version = 2;`);
    db.close();
    store = new Store(path);
    expect(store.devices.authenticate(paired.token, 2000)).toMatchObject({
      id: paired.device.id,
      scopes: ["read"],
    });
    const item = shell();
    store.appendEvents(thread.id, [
      { type: "item.created", item },
      { type: "item.created", item: message("m", "😀") },
      {
        type: "item.delta",
        itemId: item.id,
        agentId: item.agentId,
        field: "output",
        append: "result",
      },
    ]);
    expect(store.snapshotThread(thread.id).items.m).toMatchObject({ parts: [{ text: "😀" }] });
    expect(Buffer.from(store.readOutput("output:shell", 0, 100).bytes, "base64").toString()).toBe(
      "result",
    );
    store.close();
    store = new Store(path);
    expect(store.devices.authenticate(paired.token, 3000)?.id).toBe(paired.device.id);
    expect(store.snapshotThread(thread.id).itemOrder).toEqual(["shell", "m"]);
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
