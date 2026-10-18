import { FakeDaemon, facts } from "@ace/fake-daemon";
import { expect, it, vi } from "vitest";
import { fakeClient } from "@/test/fake-client.ts";
import { Jump, preloadJump } from "./jump.ts";

const text = (item: unknown) =>
  item && typeof item === "object" && "parts" in item && Array.isArray(item.parts)
    ? (item.parts[0] as { text?: string } | undefined)?.text
    : undefined;

it("paging back holds the rows shown, adds whole turns before them and stays joined to the live tail", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, snapshotItems: 200 });
  daemon.createThread({ id: "history", workspaceId: "ace", title: "History", provider: "codex" });
  daemon.apply("history", [
    facts.rootAgent("codex"),
    ...Array.from({ length: 700 }, (_, i) =>
      facts.message("root", `m-${i}`, "user", `Message ${i}`),
    ),
  ]);
  const client = fakeClient(daemon);
  await client.start();
  const lease = client.thread("history");
  const live = lease.store;
  await vi.waitFor(() => expect(live.order).toHaveLength(200));
  // Bounds smaller than the thread, so reading back reaches them.
  const jump = new Jump(client, "history", preloadJump, {
    capacity: 300,
    weight: Number.POSITIVE_INFINITY,
  });
  jump.setTail(() => ({
    order: live.order,
    before: live.itemsBefore,
    firstItemOf: () => undefined,
    seq: (id) => live.itemSeq(id),
    item: (id) => live.item(id),
    inLane: () => true,
  }));
  try {
    await jump.older();
    const firstWindow = jump.snapshot().window;
    if (!firstWindow) throw new Error("No historical window");
    // The 199 rows before the 200 shown; past its bounds the window leaves its newer end,
    // which the tail still holds, so the two are still one run.
    expect(text(firstWindow.items[0])).toBe("Message 301");
    expect(firstWindow.items).toHaveLength(300);
    expect(jump.snapshot().joined).toBe(true);
    const firstRead = firstWindow.items[0];
    const source = jump.source(live, firstWindow, true);
    expect(source?.order).toHaveLength(399);
    daemon.apply("history", [facts.message("root", "fresh", "user", "Fresh live message")]);
    await vi.waitFor(() =>
      expect(text(live.item(live.order.at(-1) ?? ""))).toBe("Fresh live message"),
    );
    jump.tailMoved();
    expect(jump.snapshot().window?.items[0]).toBe(firstRead);
    expect(live.order).toHaveLength(200);
    expect(text(source?.item(source.order.at(-1) ?? ""))).toBe("Fresh live message");

    await jump.older();
    const older = jump.snapshot().window;
    if (!older) throw new Error("No older history window");
    // Its newer end, far from where the reader reads, now ends before the tail: a gap.
    expect(older.items).toHaveLength(300);
    expect(text(older.items[0])).toBe("Message 102");
    expect(jump.snapshot().joined).toBe(false);
    const detached = jump.source(live, older, false);
    expect(detached?.order).toHaveLength(300);
    expect(detached?.order).not.toContain(live.order.at(-1));
    for (let i = 0; i < 4 && !jump.snapshot().joined; i++) await jump.newer();
    expect(jump.snapshot().joined).toBe(true);
    expect(jump.snapshot().window?.items.length).toBeLessThanOrEqual(300);
    jump.live();
    expect(jump.snapshot().window).toBeUndefined();
    expect(text(live.item(live.order.at(-1) ?? ""))).toBe("Fresh live message");
  } finally {
    jump.dispose();
    lease.release();
  }
});
