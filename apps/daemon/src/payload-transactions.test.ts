import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, EventPayload } from "@ace/protocol";
import { expect, it } from "vitest";
import { Store, createDevThread } from "./index.ts";
import { message, shell } from "./payload-test-support.ts";

it("keeps successive text and output batches isolated across rollback and reopening", () => {
  const home = mkdtempSync(join(tmpdir(), "ace-payload-transactions-"));
  const path = join(home, "events.sqlite");
  let store = new Store(path);
  try {
    const workspace = store.createWorkspace("/repo", "repo");
    const thread = createDevThread(store, workspace);
    const other = createDevThread(store, workspace);
    const output = shell();
    const text = message("text", "");
    const otherOutput = shell("other-shell");
    store.appendEvents(thread.id, [
      { type: "item.created", item: output },
      { type: "item.created", item: text },
    ]);
    store.appendEvents(other.id, [{ type: "item.created", item: otherOutput }]);
    const deltas = (append: string): EventPayload[] => [
      { type: "item.delta", itemId: output.id, agentId: output.agentId, field: "output", append },
      { type: "item.delta", itemId: text.id, agentId: text.agentId, field: "text", append },
    ];
    const published: Event[] = [];
    store.subscribe((events) => published.push(...events));
    const accepted = store.appendEvents(thread.id, deltas("first"));
    const head = store.headSeq();
    expect(() =>
      store.appendEvents(thread.id, [
        ...deltas(" rejected"),
        {
          type: "item.delta",
          itemId: otherOutput.id,
          agentId: otherOutput.agentId,
          field: "output",
          append: "cross-thread",
        },
      ]),
    ).toThrow();
    expect(store.headSeq()).toBe(head);
    expect(published).toEqual(accepted);
    accepted.push(...store.appendEvents(thread.id, deltas(" last")));
    expect(published).toEqual(accepted);
    store.close();
    store = new Store(path);
    expect(store.readEvents({ threadId: thread.id, afterSeq: head - 2, limit: 10 })).toEqual(
      accepted,
    );
    expect(Buffer.from(store.readOutput("output:shell", 0, 100).bytes, "base64").toString()).toBe(
      "first last",
    );
    const view = store.snapshotThread(thread.id);
    expect(view.items.text).toEqual(message("text", "first last"));
    expect(view.items.shell).toMatchObject({
      call: { detail: { output: { bytes: 10, tail: "first last", truncated: false } } },
    });
    expect(store.snapshotThread(other.id).items[otherOutput.id]).toEqual(otherOutput);
    expect(() => store.readOutput("output:other-shell", 0, 1)).toThrow("Unknown output stream");
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
