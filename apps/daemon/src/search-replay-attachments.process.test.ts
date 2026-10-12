import { Item, ItemId } from "@ace/protocol";
import { expect, test } from "vitest";
import { root, storeFixture } from "./long-thread-test-support.ts";

for (const interrupted of [false, true]) {
  test(`rebuild preserves small text deltas after an oversized attachment${interrupted ? " across an interrupted rebuild and restart" : " after restart"}`, async () => {
    const f = storeFixture();
    const [created] = f.store.appendEvents(f.thread.id, [
      {
        type: "item.created",
        item: Item.parse({
          id: "attachment-message",
          agentId: root,
          type: "message",
          role: "assistant",
          createdAt: 10,
          complete: false,
          parts: [
            { type: "text", text: "precedingtextneedle" },
            {
              type: "file",
              path: "attachment.bin",
              content: { encoding: "base64", data: "YWFh".repeat(180000) },
            },
          ],
        }),
      },
    ]);
    if (!created) throw new Error("Missing creation");
    for (const append of [" appendedtextneedle", " secondtextneedle"])
      f.store.appendEvents(f.thread.id, [
        {
          type: "item.delta",
          itemId: ItemId.parse("attachment-message"),
          agentId: root,
          field: "text",
          append,
        },
      ]);
    f.store.appendEvents(f.thread.id, [
      {
        type: "item.created",
        item: Item.parse({
          id: "later",
          agentId: root,
          type: "notice",
          level: "info",
          createdAt: 11,
          complete: true,
          text: "laterattachmentneedle",
        }),
      },
    ]);
    await f.restart();
    const source = {
      headSeq: () => f.store.headSeq(),
      getThread: f.store.getThread.bind(f.store),
      readEvents: f.store.readEvents.bind(f.store),
      readSearchPage(options: { afterSeq: number; limit: number; maxBytes: number }) {
        const page = f.store.readSearchPage({ ...options, limit: 1 });
        expect(page.bytes).toBeLessThanOrEqual(options.maxBytes);
        return page;
      },
    };
    if (interrupted) {
      const abort = new AbortController();
      await f.store.search.rebuild(source, {
        signal: abort.signal,
        onProgress(status) {
          if (status.indexedSeq >= created.seq) abort.abort();
        },
      });
      expect(f.store.search.status(f.store.headSeq()).indexedSeq).toBe(created.seq);
      await f.restart();
      await f.store.search.backfill(source, { signal: new AbortController().signal });
    } else await f.store.search.rebuild(source, { signal: new AbortController().signal });
    for (const queryText of ["precedingtextneedle", "appendedtextneedle", "secondtextneedle"])
      expect(
        f.store.threadSearch({ threadId: f.thread.id, text: queryText, scope: "thread", limit: 10 })
          .hits,
      ).toMatchObject([{ itemId: "attachment-message" }]);
    expect(f.store.search.query({ text: "laterattachmentneedle" }).hits).toMatchObject([
      { itemId: "later" },
    ]);
    expect(f.store.search.status(f.store.headSeq()).ready).toBe(true);
    expect(f.store.search.hasPendingWrites()).toBe(false);
    await f.restart();
    await f.store.search.backfill(f.store, { signal: new AbortController().signal });
    expect(
      f.store.threadSearch({
        threadId: f.thread.id,
        text: "appendedtextneedle",
        scope: "thread",
        limit: 10,
      }).hits,
    ).toMatchObject([{ itemId: "attachment-message" }]);
    expect(f.store.search.hasPendingWrites()).toBe(false);
  });
}
