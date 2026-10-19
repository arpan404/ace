import { afterEach, describe, expect, test, vi } from "vitest";

vi.hoisted(() => {
  let next = 0;
  Object.assign(globalThis, {
    aceHost: {
      now: () => Date.now(),
      uuid: () => `id-${++next}`,
      previewHead: (text: string, limit: number) => text.slice(0, limit),
      previewTail: (text: string, limit: number) => text.slice(-limit),
    },
  });
});

import type { FakeDaemon } from "@ace/fake-daemon";
import { ArchiveBrowser } from "./archive.ts";
import { inboxAction } from "./inbox.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * The archive browser over the real SDK and the fake daemon: the archive window pages twenty
 * threads at a time, most recently archived first, and closing returns to the home window.
 */

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function seed(daemon: FakeDaemon, archived: number) {
  for (let index = 0; index < archived; index++) {
    const id = `old-${String(index).padStart(2, "0")}`;
    daemon.createThread({
      id,
      workspaceId: "ace",
      title: `Archived ${index}`,
      provider: "codex",
      hasSentMessage: true,
    });
    // Archived in index order, so the highest index is the most recent.
    daemon.updateThread(id, { archivedAt: 10_000 + index * 1_000 });
  }
  daemon.createThread({
    id: "home",
    workspaceId: "ace",
    title: "Still here",
    provider: "codex",
    hasSentMessage: true,
  });
}

async function browsing(archived: number) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  seed(daemon, archived);
  await client.start();
  const lease = client.threads();
  closers.push(async () => lease.release());
  const sink = new RecordingSink();
  const browser = new ArchiveBrowser(client, sink);
  return { daemon, client, store: lease.store, sink, browser };
}

const list = (sink: RecordingSink) =>
  sink.read("archive:list") as
    | {
        open: boolean;
        ids?: string[];
        more?: boolean;
        loaded?: boolean;
        loading?: boolean;
        failed?: boolean;
      }
    | undefined;

describe("archive browser", () => {
  test("lists the most recently archived twenty first, then pages the rest", async () => {
    const { sink, browser } = await browsing(25);
    expect(browser.handle({ kind: "open" })).toBe(true);
    await until(() => list(sink)?.loaded === true && (list(sink)?.ids?.length ?? 0) > 0, "page");
    const first = list(sink);
    expect(first?.ids).toHaveLength(20);
    expect(first?.ids?.[0]).toBe("old-24");
    expect(first?.ids?.at(-1)).toBe("old-05");
    expect(first?.ids).not.toContain("home");
    expect(first?.more).toBe(true);

    browser.handle({ kind: "more" });
    expect(list(sink)?.loading).toBe(true);
    await until(() => list(sink)?.ids?.length === 25 && list(sink)?.loading === false, "page 2");
    expect(list(sink)?.ids?.slice(20)).toEqual(["old-04", "old-03", "old-02", "old-01", "old-00"]);
    expect(list(sink)?.more).toBe(false);
  });

  test("a second tap while a page loads asks for one page, not two", async () => {
    const { sink, browser } = await browsing(45);
    browser.handle({ kind: "open" });
    await until(() => list(sink)?.ids?.length === 20, "page");
    browser.handle({ kind: "more" });
    browser.handle({ kind: "more" });
    await until(() => list(sink)?.loading === false, "page 2");
    expect(list(sink)?.ids).toHaveLength(40);
    // Two requests for the same page would have reached all 45, or failed the second.
    expect(list(sink)?.more).toBe(true);
    expect(list(sink)?.failed).toBe(false);
  });

  test("closing leaves the archive window: archived rows leave the store", async () => {
    const { store, sink, browser } = await browsing(3);
    browser.handle({ kind: "open" });
    await until(() => list(sink)?.ids?.length === 3, "archive");
    expect(store.ids).toContain("old-01");
    browser.handle({ kind: "close" });
    expect(list(sink)).toEqual({ type: "archive.list", open: false });
    await until(() => !store.ids.includes("old-01"), "home window");
    expect(store.ids).toContain("home");
  });

  test("unarchiving from the browser takes the thread out of the list", async () => {
    const { client, sink, browser } = await browsing(2);
    browser.handle({ kind: "open" });
    await until(() => list(sink)?.ids?.length === 2, "archive");
    const pump = new RecordingSink();
    inboxAction(client, { kind: "unarchive", threadId: "old-01" }, "r1", pump);
    await until(() => list(sink)?.ids?.length === 1, "unarchived");
    expect(list(sink)?.ids).toEqual(["old-00"]);
    expect(pump.read("admission:r1")).toMatchObject({ ok: true });
  });

  test("an unknown archive action is refused", async () => {
    const { browser } = await browsing(0);
    expect(browser.handle({ kind: "delete" })).toBe(false);
  });
});
