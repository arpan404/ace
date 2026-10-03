import { expect, test } from "vitest";
import { Item } from "@ace/protocol";
import { Store, createDevThread } from "./index.ts";
import { message } from "./payload-test-support.ts";

test("indexed wire pages preserve browser artifacts created before a root agent", () => {
  const store = new Store(":memory:");
  try {
    const thread = createDevThread(store, store.createWorkspace("/repo", "Repo"));
    const artifact = Item.parse({
      id: "recording",
      type: "artifact",
      source: "browser",
      path: "recording.html",
      mimeType: "text/html",
      bytes: 10,
      createdAt: 1,
      complete: true,
    });
    store.appendEvents(thread.id, [
      { type: "item.created", item: artifact },
      { type: "item.created", item: message("transcript", "hello") },
    ]);
    const page = store.readItemPage(thread.id, store.headSeq() + 1, 2);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toEqual(artifact);
    const transcript = page.items[1];
    if (transcript?.type !== "message") throw new Error("Expected transcript");
    const part = transcript.parts[0];
    if (part?.type !== "text" || !part.source) throw new Error("Expected text source");
    const { source, ...preview } = part;
    expect({ ...transcript, parts: [preview] }).toEqual(message("transcript", "hello"));
    expect(source).toMatchObject({ bytes: 10, encoding: "utf-16le" });
    expect(
      Buffer.from(store.readOutput(source.streamId, 0, 10).bytes, "base64").toString("utf16le"),
    ).toBe("hello");
    expect(store.snapshotThread(thread.id).items.recording).toEqual(artifact);
    expect(store.getThread(thread.id)?.rootAgentId).toBeUndefined();
    const hit = store.search.query({ text: "recording", filters: { kind: "artifact" } }).hits[0];
    expect(hit).toMatchObject({ itemId: artifact.id, kind: "artifact" });
    expect(hit?.agentId).toBeUndefined();
  } finally {
    store.close();
  }
});
