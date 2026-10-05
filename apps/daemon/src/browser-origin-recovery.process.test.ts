import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { originFixture } from "./browser-origin-test-support.ts";
import { createDevThread } from "./commands.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

it("a permission tightened during an approval wait refuses the approved agent navigation", async () => {
  const f = await originFixture();
  const opened = f.opened();
  const failure = expect(f.navigation()).rejects.toMatchObject({
    blocked: { reason: "read_only", origin: "https://youtube.com" },
  });
  const interaction = await opened;
  f.store.appendEvents(f.thread.id, [
    {
      type: "thread.updated",
      permission: { override: "read-only", effective: "read-only", pending: false },
    },
  ]);
  expect(f.resolve(interaction, "allow_once").ok).toBe(true);
  await failure;
  expect(f.browser.state(f.thread.id).url).toBe("about:blank");
  expect(f.browser.originsList(f.thread.id)).toEqual([]);
});

it("restart expires an unresolved persisted approval and never replays its navigation or grants a late answer", async () => {
  const f = await originFixture();
  const opened = f.opened();
  const failure = expect(f.navigation()).rejects.toThrow();
  const interaction = await opened;
  const home = await mkdtemp(join(tmpdir(), "ace-origin-crash-"));
  homes.push(home);
  // SQLite produces a transactionally consistent crash snapshot with pending work.
  const snapshot = new DatabaseSync(join(f.home, "events.sqlite"));
  try {
    snapshot.prepare("VACUUM INTO ?").run(join(home, "events.sqlite"));
  } finally {
    snapshot.close();
  }
  await f.close();
  await failure;
  const restarted = await originFixture("ask", home);
  expect(restarted.store.getInteraction(interaction.id)?.state).toBe("expired");
  expect(restarted.browser.state(restarted.thread.id).url).toBe("about:blank");
  expect(restarted.browser.originsList(restarted.thread.id)).toEqual([]);
  expect(restarted.resolve(interaction, "allow_thread").ok).toBe(false);
});

it("the global grant limit survives restart and deletion or revoke frees exactly that capacity", async () => {
  const f = await originFixture();
  const threads = [f.thread];
  for (let count = 1; count < 64; count++)
    threads.push(createDevThread(f.store, f.thread.workspaceId));
  for (const thread of threads)
    for (let count = 0; count < 256; count++)
      f.browser.originsGrant(thread.id, `https://site-${count}.example`);
  const extra = createDevThread(f.store, f.thread.workspaceId);
  expect(() => f.browser.originsGrant(extra.id, "https://extra.example")).toThrow("grant limit");
  await f.close();
  const restarted = await originFixture("ask", f.home);
  expect(() => restarted.browser.originsGrant(extra.id, "https://extra.example")).toThrow(
    "grant limit",
  );
  restarted.browser.originsRevoke(f.thread.id, "https://site-0.example");
  restarted.browser.originsGrant(extra.id, "https://extra.example");
  expect(restarted.browser.originsList(extra.id)).toHaveLength(1);
  const removed = threads[1];
  if (!removed) throw new Error("Missing thread");
  restarted.store.deleteThread(removed.id);
  for (let count = 0; count < 255; count++)
    restarted.browser.originsGrant(extra.id, `https://extra-${count}.example`);
  const final = createDevThread(restarted.store, f.thread.workspaceId);
  restarted.browser.originsGrant(final.id, "https://last.example");
  expect(() => restarted.browser.originsGrant(final.id, "https://overflow.example")).toThrow(
    "grant limit",
  );
}, 60_000);

it("the global pending approval limit refuses overflow and cancellation frees a slot", async () => {
  const f = await originFixture();
  const origins = f.context.services.browserOrigins;
  if (!origins) throw new Error("Missing origin service");
  const ready = Promise.withResolvers<void>();
  let count = 0;
  const stop = f.store.subscribe((events) => {
    for (const event of events)
      if (event.payload.type === "interaction.opened" && ++count === 32) ready.resolve();
  });
  const signals = Array.from({ length: 32 }, () => new AbortController());
  const pending = signals.map((signal, index) =>
    origins
      .allowed({
        threadId: f.thread.id,
        origin: `https://approval-${index}.example`,
        url: `https://approval-${index}.example/`,
        navigation: true,
        signal: signal.signal,
      })
      .catch((error: unknown) => error),
  );
  await ready.promise;
  stop();
  await expect(
    origins.allowed({
      threadId: f.thread.id,
      origin: "https://overflow.example",
      url: "https://overflow.example/",
      navigation: true,
    }),
  ).rejects.toThrow("approval limit");
  signals[0]?.abort();
  await pending[0];
  const opened = f.opened();
  const replacement = origins.allowed({
    threadId: f.thread.id,
    origin: "https://replacement.example",
    url: "https://replacement.example/",
    navigation: true,
  });
  const interaction = await opened;
  expect(f.resolve(interaction, "allow_once").ok).toBe(true);
  expect(await replacement).toBe(true);
  for (const signal of signals) signal.abort();
  await Promise.all(pending);
});
