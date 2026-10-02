import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { reviewFixture } from "./history-review-support.ts";

for (const boundary of ["exit", "restart"] as const)
  test(`a second fork after ${boundary} starts from the persisted native conversation`, async () => {
    const f = await reviewFixture();
    try {
      expect(await f.continueThread("fork")).toMatchObject({
        status: "continued",
        nativeSessionId: "fork-1",
      });
      await f.emit("fork-1", "work added to branch B");
      let client = f.client;
      if (boundary === "exit") await f.exit("fork-1");
      else client = await f.restart();
      expect(await f.continueThread("fork", client)).toMatchObject({
        status: "continued",
        nativeSessionId: "fork-2",
      });
      const receipts = (await readFile(join(f.root, "fork-receipts.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) =>
          z.object({ instanceId: z.string(), nativeSessionId: z.string() }).parse(JSON.parse(line)),
        );
      expect(receipts).toEqual([
        { instanceId: "account", nativeSessionId: "A" },
        { instanceId: "account", nativeSessionId: "fork-1" },
      ]);
      expect(Object.values(f.store.snapshotThread(f.threadId).items)).toContainEqual(
        expect.objectContaining({ text: "work added to branch B" }),
      );
      expect(Object.values(f.store.snapshotThread(f.threadId).agents)[0]?.native.nativeId).toBe(
        "fork-2",
      );
    } finally {
      await f.close();
    }
  });

test("every live item and exit survives publication of another imported thread", async () => {
  const f = await reviewFixture();
  try {
    expect(await f.continueThread("resume")).toMatchObject({
      status: "continued",
      nativeSessionId: "A",
    });
    const overlap = Promise.withResolvers<void>();
    let delivered: Promise<void> | undefined;
    const stop = f.store.subscribe((events) => {
      if (
        !events.some(
          (event) =>
            event.payload.type === "thread.created" && event.payload.thread.title === "other",
        )
      )
        return;
      // Committed import notifications run while the Store lease is still held.
      delivered = (async () => {
        await f.emit("A", "live before exit");
        await f.emit("A", "live second item");
        await f.exit("A");
      })();
      // Keep a rejected callback promise observed until the behaviour assertion.
      void delivered.catch(() => undefined);
      overlap.resolve();
    });
    try {
      const result = f.importRequest(f.client, "other");
      await overlap.promise;
      expect(await result).toMatchObject({ type: "history.import", status: "imported" });
      if (!delivered) throw new Error("Missing overlapping native delivery");
      await delivered;
      expect(
        Object.values(f.store.snapshotThread(f.threadId).items)
          .filter((i) => i.type === "notice")
          .map((i) => i.text),
      ).toEqual(["live before exit", "live second item", "exit: native finished"]);
      // The exit released the active session; continuation can fork again.
      expect(await f.continueThread("fork")).toMatchObject({ status: "continued" });
    } finally {
      stop();
    }
  } finally {
    await f.close();
  }
});

test("an active adapter without publication backpressure keeps persisting after import is refused", async () => {
  const f = await reviewFixture(false);
  try {
    expect(await f.continueThread("resume")).toMatchObject({ status: "continued" });
    expect(await f.importRequest(f.client, "other")).toMatchObject({
      type: "error",
      code: "history_rejected",
    });
    await f.emit("A", "live stream still persists");
    await f.exit("A");
    expect(f.store.listThreads()).toHaveLength(1);
    expect(Object.values(f.store.snapshotThread(f.threadId).items)).toContainEqual(
      expect.objectContaining({ text: "live stream still persists" }),
    );
    expect(await f.importRequest(f.client, "other")).toMatchObject({
      type: "history.import",
      status: "imported",
    });
  } finally {
    await f.close();
  }
});

test("cancelling an import at the persistence barrier resumes live callbacks and permits retry", async () => {
  const f = await reviewFixture();
  const pause = f.holdNextPause();
  try {
    expect(await f.continueThread("resume")).toMatchObject({ status: "continued" });
    const importing = f.importRequest(f.client, "other").catch(() => undefined);
    await pause.entered.promise;
    const delivered = f.emit("A", "live after import cancellation");
    await f.client.close();
    await pause.aborted.promise;
    pause.proceed.resolve();
    await pause.released.promise;
    await delivered;
    await importing;
    expect(f.store.listThreads()).toHaveLength(1);
    expect(Object.values(f.store.snapshotThread(f.threadId).items)).toContainEqual(
      expect.objectContaining({ text: "live after import cancellation" }),
    );
    const reconnected = await f.connect();
    expect(await f.importRequest(reconnected, "other")).toMatchObject({
      type: "history.import",
      status: "imported",
    });
  } finally {
    pause.proceed.resolve();
    await f.close();
  }
});
