import { Item, ItemId } from "@ace/protocol";
import { expect, test } from "vitest";
import { root, storeFixture } from "./long-thread-test-support.ts";

for (const type of ["notice", "message"] as const) {
  test(`oversized ${type} metadata preserves the durable text interior and tail through restart`, async () => {
    const f = storeFixture();
    const text =
      "texthead " + "word ".repeat(10000) + " textinterior " + "word ".repeat(10000) + " texttail";
    f.store.appendEvents(f.thread.id, [
      {
        type: "item.created",
        item: Item.parse({
          id: "large-text",
          agentId: root,
          type,
          createdAt: 10,
          complete: false,
          ...(type === "notice"
            ? { level: "info", detail: "x".repeat(700000), text }
            : {
                role: "assistant",
                parts: [
                  { type: "file", path: "x".repeat(700000) },
                  { type: "text", text },
                ],
              }),
        }),
      },
    ]);
    // A large delta must resolve the source at the delta, not at creation.
    f.store.appendEvents(f.thread.id, [
      {
        type: "item.delta",
        itemId: ItemId.parse("large-text"),
        agentId: root,
        field: "text",
        // Lead with a space so the original tail stays its own searchable word.
        append: " " + "next ".repeat(140000) + " appendedtexttail",
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
          text: "latertextneedle",
        }),
      },
    ]);
    await f.restart();
    await f.store.search.rebuild(f.store, { signal: new AbortController().signal });
    expect(f.store.search.status(f.store.headSeq()).ready).toBe(true);
    expect(f.store.search.query({ text: "appendedtexttail" }).hits).toMatchObject([
      { itemId: "large-text" },
    ]);
    for (const queryText of ["texthead", "textinterior", "texttail", "appendedtexttail"])
      expect(
        f.store.threadSearch({ threadId: f.thread.id, text: queryText, scope: "thread", limit: 10 })
          .hits,
      ).toMatchObject([{ itemId: "large-text" }]);
    expect(f.store.search.query({ text: "latertextneedle" }).hits).toMatchObject([
      { itemId: "later" },
    ]);
  });
}

test("oversized shell metadata resolves output at each replayed sequence without leaking future bytes", async () => {
  const f = storeFixture();
  const [created] = f.store.appendEvents(f.thread.id, [
    {
      type: "item.created",
      item: Item.parse({
        id: "shell",
        agentId: root,
        type: "tool_call",
        createdAt: 10,
        complete: false,
        call: {
          id: "shell",
          agentId: root,
          kind: "shell",
          title: "Build",
          status: "running",
          startedAt: 10,
          raw: [],
          detail: { kind: "shell", command: "commandhead " + "x".repeat(700000) + " commandtail" },
        },
      }),
    },
  ]);
  const [delta] = f.store.appendEvents(f.thread.id, [
    {
      type: "item.delta",
      itemId: ItemId.parse("shell"),
      agentId: root,
      field: "output",
      append:
        "outputhead " +
        "x ".repeat(180000) +
        " outputinterior " +
        "y ".repeat(180000) +
        " outputtail",
    },
  ]);
  f.store.appendEvents(f.thread.id, [
    {
      type: "item.delta",
      itemId: ItemId.parse("shell"),
      agentId: root,
      field: "output",
      append: " futureoutputneedle",
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
        text: "lateroutputneedle",
      }),
    },
  ]);
  if (!created || !delta) throw new Error("Missing event");
  await f.restart();
  const source = {
    headSeq: () => f.store.headSeq(),
    getThread: f.store.getThread.bind(f.store),
    readEvents: f.store.readEvents.bind(f.store),
    readSearchPage(options: { afterSeq: number; limit: number; maxBytes: number }) {
      const page = f.store.readSearchPage({ ...options, limit: 1 });
      expect(page.bytes).toBeLessThanOrEqual(options.maxBytes);
      if (options.afterSeq < f.store.headSeq())
        expect(page.throughSeq).toBeGreaterThan(options.afterSeq);
      return page;
    },
  };
  const stopAtCreation = new AbortController();
  await f.store.search.rebuild(source, {
    signal: stopAtCreation.signal,
    onProgress: (status) => {
      if (status.indexedSeq >= created.seq) stopAtCreation.abort();
    },
  });
  expect(f.store.search.status(f.store.headSeq()).indexedSeq).toBe(created.seq);
  expect(f.store.search.query({ text: "outputhead" }).hits).toEqual([]);
  expect(
    f.store.threadSearch({
      threadId: f.thread.id,
      text: "futureoutputneedle",
      scope: "thread",
      limit: 10,
    }).hits,
  ).toEqual([]);
  const stopAtDelta = new AbortController();
  await f.store.search.backfill(source, {
    signal: stopAtDelta.signal,
    onProgress: (status) => {
      if (status.indexedSeq >= delta.seq) stopAtDelta.abort();
    },
  });
  expect(f.store.search.status(f.store.headSeq()).indexedSeq).toBe(delta.seq);
  expect(f.store.search.query({ text: "outputtail" }).hits).toMatchObject([{ itemId: "shell" }]);
  for (const queryText of ["outputhead", "outputinterior", "outputtail"])
    expect(
      f.store.threadSearch({ threadId: f.thread.id, text: queryText, scope: "thread", limit: 10 })
        .hits,
    ).toMatchObject([{ itemId: "shell" }]);
  expect(f.store.search.query({ text: "futureoutputneedle" }).hits).toEqual([]);
  expect(
    f.store.threadSearch({
      threadId: f.thread.id,
      text: "futureoutputneedle",
      scope: "thread",
      limit: 10,
    }).hits,
  ).toEqual([]);
  await f.store.search.backfill(source, { signal: new AbortController().signal });
  expect(f.store.search.status(f.store.headSeq()).ready).toBe(true);
  expect(f.store.search.query({ text: "futureoutputneedle" }).hits).toMatchObject([
    { itemId: "shell" },
  ]);
  expect(
    f.store.threadSearch({
      threadId: f.thread.id,
      text: "futureoutputneedle",
      scope: "thread",
      limit: 10,
    }).hits,
  ).toMatchObject([{ itemId: "shell" }]);
  expect(f.store.search.query({ text: "lateroutputneedle" }).hits).toMatchObject([
    { itemId: "later" },
  ]);
});

for (const difference of [-1, 0, 1]) {
  test(`replay advances when a payload is ${difference === 0 ? "equal to" : difference < 0 ? "one byte below" : "one byte above"} its actual envelope capacity`, async () => {
    const f = storeFixture();
    const [probe] = f.store.appendEvents(
      f.thread.id,
      [
        {
          type: "item.created",
          item: Item.parse({
            id: "probe",
            agentId: root,
            type: "notice",
            level: "info",
            createdAt: 10,
            complete: true,
            text: "probe",
          }),
        },
      ],
      30,
    );
    if (!probe) throw new Error("Missing probe event");
    // The wire event has a fixed-width UUID. Include the array envelope and a
    // row delimiter in the budget, rather than assuming an arbitrary 1 KiB overhead.
    const envelope = { ...probe, seq: probe.seq + 1, at: 30, payload: null };
    const overhead = Buffer.byteLength(JSON.stringify(envelope)) - 4 + 1;
    const capacity = 524288 - 2 - overhead;
    const item = Item.parse({
      id: "boundary",
      agentId: root,
      type: "notice",
      level: "info",
      createdAt: 10,
      complete: true,
      text: "boundaryhead boundarytail",
    });
    if (item.type !== "notice") throw new Error("Wrong item");
    const payload = { type: "item.created" as const, item };
    const padding = capacity + difference - Buffer.byteLength(JSON.stringify(payload));
    // Same length as unbroken padding, but the tail stays its own searchable word.
    item.text = "boundaryhead " + "x".repeat(padding - 1) + " boundarytail";
    const [created] = f.store.appendEvents(f.thread.id, [payload], 30);
    if (!created) throw new Error("Missing boundary event");
    const actualOverhead = Buffer.byteLength(JSON.stringify({ ...created, payload: null })) - 4 + 1;
    expect(Buffer.byteLength(JSON.stringify(created.payload)) - (524288 - 2 - actualOverhead)).toBe(
      difference,
    );
    f.store.appendEvents(f.thread.id, [
      {
        type: "item.created",
        item: Item.parse({
          id: "later",
          agentId: root,
          type: "notice",
          level: "info",
          createdAt: 10,
          complete: true,
          text: "pastactualboundary",
        }),
      },
    ]);
    const page = f.store.readSearchPage({ afterSeq: probe.seq, limit: 256, maxBytes: 524288 });
    expect(page.throughSeq).toBeGreaterThanOrEqual(created.seq);
    expect(page.bytes).toBeLessThanOrEqual(524288);
    await f.store.search.rebuild(f.store, { signal: new AbortController().signal });
    expect(f.store.search.status(f.store.headSeq()).ready).toBe(true);
    expect(f.store.search.query({ text: "boundarytail" }).hits).toMatchObject([
      { itemId: "boundary" },
    ]);
    expect(f.store.search.query({ text: "pastactualboundary" }).hits).toMatchObject([
      { itemId: "later" },
    ]);
  });
}
