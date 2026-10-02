import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { AgentItem } from "@ace/protocol";
import { Store, createDevThread } from "./index.ts";

it("appending to a multipart text stream never reads the previous preview body", () => {
  const db = new DatabaseSync(":memory:");
  const store = new Store(":memory:", undefined, { database: db });
  try {
    const thread = createDevThread(store, store.createWorkspace("/repo", "repo"));
    const item = AgentItem.parse({
      type: "message",
      id: "multipart",
      agentId: "root",
      role: "assistant",
      complete: false,
      createdAt: 0,
      parts: Array.from({ length: 200 }, () => ({ type: "text", text: "" })),
    });
    store.appendEvents(thread.id, [{ type: "item.created", item }]);
    let block = true;
    db.function("preview_body", (value) => {
      if (block) throw new Error("read old multipart preview");
      return value;
    });
    db.exec(
      "ALTER TABLE item_previews RENAME TO metered_previews; CREATE VIEW item_previews AS SELECT id, preview_body(item) AS item, target FROM metered_previews",
    );
    store.appendEvents(thread.id, [
      { type: "item.delta", itemId: item.id, agentId: item.agentId, field: "text", append: "tail" },
    ]);
    block = false;
    const page = store.readItemPage(thread.id, store.headSeq() + 1, 1);
    const preview = page.items[0];
    if (preview?.type !== "message") throw new Error("preview");
    const part = preview.parts.at(-1);
    if (part?.type !== "text" || !part.source) throw new Error("source");
    expect(
      Buffer.from(store.readOutput(part.source.streamId, 0, 8).bytes, "base64").toString("utf16le"),
    ).toBe("tail");
    expect(part.source.bytes).toBe(8);
  } finally {
    store.close();
  }
});
