import { Item, ItemId, type ContentPart } from "@ace/protocol";
import { expect, test } from "vitest";
import { root, storeFixture } from "./long-thread-test-support.ts";

for (const layout of ["empty", "attachment-last", "text-last"] as const) {
  test(`rebuild bounds ten thousand ${layout} text sources and preserves later deltas across restart`, async () => {
    const f = storeFixture();
    const parts: ContentPart[] = Array.from({ length: 10000 }, (_, index) => ({
      type: "text",
      text:
        layout === "empty"
          ? ""
          : index === 0
            ? "aggregatehead"
            : index === 5000
              ? "aggregateinterior 🦊"
              : index === 9999
                ? "aggregatetail"
                : "word",
    }));
    const attachment: ContentPart = {
      type: "file",
      path: "attachment.bin",
      content: { encoding: "base64", data: "YWFh".repeat(180000) },
    };
    parts.splice(layout === "text-last" ? 9999 : parts.length, 0, attachment);
    const before = f.store.headSeq();
    const [created] = f.store.appendEvents(f.thread.id, [
      {
        type: "item.created",
        item: Item.parse({
          id: "many-parts",
          agentId: root,
          type: "message",
          role: "assistant",
          createdAt: 10,
          complete: false,
          parts,
        }),
      },
    ]);
    if (!created) throw new Error("Missing creation");
    f.store.appendEvents(f.thread.id, [
      {
        type: "item.delta",
        itemId: ItemId.parse("many-parts"),
        agentId: root,
        field: "text",
        append: " appendedpartneedle",
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
          text: "laterpartneedle",
        }),
      },
    ]);
    await f.restart();
    const page = f.store.readSearchPage({ afterSeq: before, limit: 1, maxBytes: 524288 });
    expect(page.throughSeq).toBe(created.seq);
    expect(page.bytes).toBeLessThanOrEqual(524288);
    expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(524288);
    const source = {
      headSeq: () => f.store.headSeq(),
      getThread: f.store.getThread.bind(f.store),
      readEvents: f.store.readEvents.bind(f.store),
      readSearchPage(options: { afterSeq: number; limit: number; maxBytes: number }) {
        const next = f.store.readSearchPage({ ...options, limit: 1 });
        expect(next.bytes).toBeLessThanOrEqual(options.maxBytes);
        return next;
      },
    };
    const abort = new AbortController();
    await f.store.search.rebuild(source, {
      signal: abort.signal,
      onProgress(status) {
        if (status.indexedSeq >= created.seq) abort.abort();
      },
    });
    expect(f.store.search.status(f.store.headSeq()).indexedSeq).toBe(created.seq);
    expect(
      f.store.threadSearch({
        threadId: f.thread.id,
        text: "appendedpartneedle",
        scope: "thread",
        limit: 10,
      }).hits,
    ).toEqual([]);
    if (layout !== "empty") {
      for (const queryText of ["aggregatehead", "aggregateinterior", "aggregatetail"])
        expect(
          f.store.threadSearch({
            threadId: f.thread.id,
            text: queryText,
            scope: "thread",
            limit: 10,
          }).hits,
        ).toMatchObject([{ itemId: "many-parts" }]);
    }
    await f.restart();
    await f.store.search.backfill(source, { signal: new AbortController().signal });
    expect(f.store.search.status(f.store.headSeq()).ready).toBe(true);
    expect(f.store.search.hasPendingWrites()).toBe(false);
    expect(
      f.store.threadSearch({
        threadId: f.thread.id,
        text: "appendedpartneedle",
        scope: "thread",
        limit: 10,
      }).hits,
    ).toMatchObject([{ itemId: "many-parts" }]);
    expect(f.store.search.query({ text: "laterpartneedle" }).hits).toMatchObject([
      { itemId: "later" },
    ]);
    await f.store.search.rebuild(source, { signal: new AbortController().signal });
    expect(f.store.search.hasPendingWrites()).toBe(false);
    expect(
      f.store.threadSearch({
        threadId: f.thread.id,
        text: "appendedpartneedle",
        scope: "thread",
        limit: 10,
      }).hits,
    ).toMatchObject([{ itemId: "many-parts" }]);
    if (layout !== "empty")
      expect(
        f.store.threadSearch({
          threadId: f.thread.id,
          text: "aggregateinterior",
          scope: "thread",
          limit: 10,
        }).hits,
      ).toMatchObject([{ itemId: "many-parts" }]);
  });
}
