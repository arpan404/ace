import { FakeDaemon, facts } from "@ace/fake-daemon";
import { expect, it, vi } from "vitest";
import { fakeClient } from "@/test/fake-client.ts";
import { Jump } from "./jump.ts";

it("paging back keeps a bounded history window beside the live tail through new deliveries", async () => {
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
  const jump = new Jump(client, "history");
  jump.setTail(() => ({
    order: live.order,
    before: live.itemsBefore,
    firstItemOf: () => undefined,
  }));
  try {
    await jump.older();
    const firstWindow = jump.snapshot().window;
    if (!firstWindow) throw new Error("No historical window");
    expect(firstWindow.items[0]).toMatchObject({ parts: [{ type: "text", text: "Message 450" }] });
    expect(jump.snapshot().joined).toBe(true);
    const firstRead = firstWindow.items[0];
    const source = jump.source(live, firstWindow, true);
    expect(source?.order).toHaveLength(250);
    daemon.apply("history", [facts.message("root", "fresh", "user", "Fresh live message")]);
    await vi.waitFor(() =>
      expect(live.item(live.order.at(-1) ?? "")).toMatchObject({
        parts: [{ type: "text", text: "Fresh live message" }],
      }),
    );
    expect(jump.snapshot().window?.items[0]).toBe(firstRead);
    expect(live.order).toHaveLength(200);
    expect(source?.item(source.order.at(-1) ?? "")).toMatchObject({
      parts: [{ type: "text", text: "Fresh live message" }],
    });

    await jump.older();
    await jump.older();
    const older = jump.snapshot().window;
    expect(older?.items).toHaveLength(200);
    expect(older?.items[0]).toMatchObject({ parts: [{ type: "text", text: "Message 250" }] });
    // Sliding far enough leaves a gap: do not render the live tail across missing history.
    expect(jump.snapshot().joined).toBe(false);
    if (!older) throw new Error("No older history window");
    const detached = jump.source(live, older, false);
    expect(detached?.order).toHaveLength(200);
    expect(detached?.order).not.toContain(live.order.at(-1));
    for (let i = 0; i < 4 && !jump.snapshot().joined; i++) await jump.newer();
    expect(jump.snapshot().joined).toBe(true);
    expect(jump.snapshot().window?.items.length).toBeLessThanOrEqual(200);
    jump.live();
    expect(jump.snapshot().window).toBeUndefined();
    expect(live.item(live.order.at(-1) ?? "")).toMatchObject({
      parts: [{ type: "text", text: "Fresh live message" }],
    });
  } finally {
    jump.dispose();
    lease.release();
  }
});
