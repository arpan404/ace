import "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { ClientCore } from "@ace/client";
import { CatalogPage } from "./catalog-page.ts";
import { CatalogReads } from "./composer-catalog.ts";
import { connect, fixture, reset, until } from "./thread-harness.ts";

/*
 * The Skills and commands pages read the catalog through the composer's reader: a cached
 * (stale) first answer is read again while discovery runs, and only an answer still stale after
 * the composer's retries is shown as cached. Time is the one thing faked: each pause between
 * reads runs at once, and `paused` sees it happen.
 */

afterEach(reset);

function daemon(): FakeDaemon {
  const fake = fixture();
  fake.createThread({ id: "here", workspaceId: "ace", title: "Catalog work", provider: "claude" });
  fake.apply("here", [facts.rootAgent("claude"), facts.turn("root"), facts.endTurn("root")]);
  return fake;
}
const discovering = (fake: FakeDaemon, still: boolean) =>
  fake.seedServices({ extensionCatalogs: {}, catalogLoading: still ? ["claude"] : [] });

async function page(fake: FakeDaemon, paused: (pauses: number) => void = () => {}) {
  const client: ClientCore = connect(fake);
  client.threads();
  await until(() => client.connectionState().getSnapshot() === "ready", "the connection");
  let pauses = 0;
  return new CatalogPage(
    new CatalogReads({
      owner: client,
      now: () => Date.now(),
      draft: { draftScope: async () => "draft" },
    }),
    (_delay, run) => {
      paused(++pauses);
      queueMicrotask(run);
      return () => {};
    },
  );
}
const signal = () => new AbortController().signal;

test("a cached first answer is read again until discovery ends, then shows fresh entries", async () => {
  const fake = daemon();
  discovering(fake, true);
  const catalog = await page(fake, (pauses) => {
    if (pauses === 2) discovering(fake, false);
  });

  const first = await catalog.answer({ type: "catalog.page", threadId: "here" }, signal());
  expect(first).toMatchObject({ stale: true, refreshing: true });
  expect(first.notice).toBe("Refreshing skills and commands…");
  expect(first.entries.length).toBeGreaterThan(0);

  const settled = await catalog.answer(
    { type: "catalog.page", threadId: "here", settle: true },
    signal(),
  );
  expect(settled).toMatchObject({ stale: false, refreshing: false, notice: null });
  expect(settled.entries.length).toBeGreaterThan(0);
});

test("entries still stale after every retry are shown as cached, never blaming the machine", async () => {
  const fake = daemon();
  discovering(fake, true);
  let pauses = 0;
  const catalog = await page(fake, (count) => (pauses = count));

  await catalog.answer({ type: "catalog.page", threadId: "here" }, signal());
  const settled = await catalog.answer(
    { type: "catalog.page", threadId: "here", settle: true },
    signal(),
  );

  expect(pauses).toBe(6);
  expect(settled).toMatchObject({ stale: true, refreshing: false });
  expect(settled.notice).toBe("Showing cached entries. Pull to refresh to read them again.");
  expect(settled.entries.length).toBeGreaterThan(0);
});

test("a project's catalog for one coding agent reads fresh without a pause", async () => {
  const fake = daemon();
  let pauses = 0;
  const catalog = await page(fake, (count) => (pauses = count));

  const first = await catalog.answer(
    { type: "catalog.page", workspace: { workspaceId: "ace", provider: "claude" } },
    signal(),
  );

  expect(first).toMatchObject({ stale: false, refreshing: false, notice: null });
  expect(first.entries.length).toBeGreaterThan(0);
  expect(pauses).toBe(0);
});
