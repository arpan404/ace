import { expect, test, vi } from "vitest";
import { SettingsService } from "@ace/settings";
import { ThreadOrganizer } from "./thread-organizer.ts";
import { fixture } from "./socket-test-support.ts";

const day = 86_400_000;

test("turning off inactivity settling during a policy read never applies the old deadline", async () => {
  let now = 1000;
  const f = await fixture({ now: () => now });
  f.store.atomic((db) =>
    db.prepare("UPDATE workspaces SET path=? WHERE id=?").run(f.home, f.workspace),
  );
  const settings = new SettingsService({ dataDir: f.home });
  const organizer = new ThreadOrganizer(
    f.store,
    settings,
    () => now,
    () => () => {},
  );
  try {
    f.store.appendEvents(f.thread.id, [{ type: "thread.updated", status: { state: "done" } }], now);
    await organizer.sweep();
    now += 2 * day;
    const read = settings.read.bind(settings);
    vi.spyOn(settings, "read").mockImplementationOnce(async (selector) => {
      const old = await read(selector);
      await settings.set("threads.autoSettleAfter", "never", { kind: "global" });
      return old;
    });
    await organizer.sweep();
    expect(f.store.getThread(f.thread.id)?.settledAt).toBeUndefined();
    await organizer.sweep();
    expect(f.store.getThread(f.thread.id)?.settledAt).toBeUndefined();
    expect(f.store.getThread(f.thread.id)?.autoSettleAt).toBeUndefined();
  } finally {
    await organizer.close();
    await settings.close();
    await f.close();
  }
});

test("a no-PR thread obeys changes to the inactivity setting across organizer restarts", async () => {
  let now = 1000;
  const f = await fixture({ now: () => now });
  f.store.atomic((db) =>
    db.prepare("UPDATE workspaces SET path=? WHERE id=?").run(f.home, f.workspace),
  );
  const settings = new SettingsService({ dataDir: f.home });
  let organizer = new ThreadOrganizer(
    f.store,
    settings,
    () => now,
    () => () => {},
  );
  try {
    await settings.set("threads.autoSettleAfter", "never", { kind: "global" });
    f.store.appendEvents(f.thread.id, [{ type: "thread.updated", status: { state: "done" } }], now);
    await organizer.sweep();
    now += 10 * day;
    await organizer.close();
    organizer = new ThreadOrganizer(
      f.store,
      settings,
      () => now,
      () => () => {},
    );
    await organizer.sweep();
    expect(f.store.getThread(f.thread.id)?.settledAt).toBeUndefined();
    await settings.set("threads.autoSettleAfter", "1w", { kind: "global" });
    await organizer.sweep();
    await organizer.sweep();
    expect(f.store.getThread(f.thread.id)?.settledReason).toBe("inactivity");
  } finally {
    await organizer.close();
    await settings.close();
    await f.close();
  }
});

test("a linked PR set waits for every merge and remembers settling across restart", async () => {
  const f = await fixture();
  let organizer = new ThreadOrganizer(
    f.store,
    undefined,
    () => 1000,
    () => () => {},
  );
  const link = (second: "open" | "merged") =>
    f.store.appendEvents(
      f.thread.id,
      [
        {
          type: "thread.client.updated",
          changes: {
            details: {
              linkedPrs: ["merged" as const, second].map((state, index) => ({
                number: index + 1,
                state,
                repo: {
                  forge: "github" as const,
                  host: "github.com",
                  owner: "owner",
                  name: "repo",
                },
                url: `https://github.com/owner/repo/pull/${index + 1}`,
                updatedAt: 1,
              })),
            },
          },
        },
      ],
      1000,
    );
  try {
    link("open");
    await organizer.sweep();
    expect(f.store.getThread(f.thread.id)?.settledAt).toBeUndefined();
    link("merged");
    await organizer.sweep();
    expect(f.store.getThread(f.thread.id)?.settledReason).toBe("pr_merged");
    f.store.appendEvents(
      f.thread.id,
      [{ type: "thread.client.updated", changes: { settledAt: null, settledReason: null } }],
      1000,
    );
    await organizer.close();
    organizer = new ThreadOrganizer(
      f.store,
      undefined,
      () => 1000,
      () => () => {},
    );
    await organizer.sweep();
    expect(f.store.getThread(f.thread.id)?.settledAt).toBeUndefined();
  } finally {
    await organizer.close();
    await f.close();
  }
});
