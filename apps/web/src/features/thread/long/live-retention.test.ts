import { FakeDaemon, facts } from "@ace/fake-daemon";
import { expect, it, vi } from "vitest";
import { fakeClient } from "@/test/fake-client.ts";
import * as loaded from "./jump-controller.ts";
import { Jump } from "./jump.ts";

it("leaving live retains a bounded readable window before lazy history code loads or streaming evicts it", async () => {
  let clock = 0;
  const daemon = new FakeDaemon({ clock: () => ++clock, snapshotItems: 200 });
  daemon.createThread({ id: "retained", workspaceId: "ace", title: "Retained", provider: "codex" });
  daemon.apply("retained", [
    facts.rootAgent("codex"),
    ...Array.from({ length: 210 }, (_, i) =>
      facts.message("root", `m-${i}`, "user", `Message ${i}`),
    ),
  ]);
  const client = fakeClient(daemon);
  await client.start();
  const lease = client.thread("retained");
  const live = lease.store;
  await vi.waitFor(() => expect(live.order).toHaveLength(200));
  const original = [...live.order];
  const chunk = Promise.withResolvers<typeof loaded>();
  const jump = new Jump(client, "retained", () => chunk.promise);
  jump.setTail(() => ({
    order: live.order,
    before: live.itemsBefore,
    firstItemOf: () => undefined,
  }));
  try {
    jump.retain(live);
    const retained = jump.snapshot().window;
    if (!retained) throw new Error("Reader's window was not retained");
    expect(retained.items.map((item) => item.id)).toEqual(original);
    expect(jump.snapshot().focus).toBeUndefined();
    expect(jump.snapshot().loading).toBeUndefined();
    // Retention itself works before the history chunk loads and does not fetch or place a row.
    const source = jump.source(live, retained, true);
    expect(source?.order).toEqual(original);
    daemon.apply("retained", [
      facts.turn("root"),
      ...Array.from({ length: 220 }, (_, i) =>
        facts.message("root", `fresh-${i}`, "assistant", `Fresh ${i}`),
      ),
    ]);
    await vi.waitFor(() => expect(live.order.some((id) => original.includes(id))).toBe(false));
    jump.tailMoved();
    expect(jump.snapshot().joined).toBe(false);
    const detached = jump.source(live, retained, false);
    expect(detached?.order).toEqual(original);
    expect(detached?.item(original[0] ?? "")).toMatchObject({
      parts: [{ type: "text", text: "Message 10" }],
    });
    expect(live.order).toHaveLength(200);
    expect(detached?.thread?.status.state).toBe("working");
    daemon.apply("retained", [facts.endTurn("root")]);
    await vi.waitFor(() => expect(detached?.thread?.status.state).toBe("done"));
    const pending = jump.snapshot();
    chunk.resolve(loaded);
    await vi.waitFor(() => expect(jump.snapshot()).not.toBe(pending));
    expect(jump.snapshot().window).toBe(retained);
    expect(jump.snapshot().joined).toBe(false);
    // One gesture can slide the retained window; new arrivals did not slide it themselves.
    await jump.newer();
    expect(jump.snapshot().window?.items.length).toBeLessThanOrEqual(200);
    expect(jump.snapshot().window?.items.map((item) => item.id)).not.toEqual(original);
    jump.live();
    expect(jump.snapshot().window).toBeUndefined();
    expect(live.order).toHaveLength(200);
  } finally {
    chunk.resolve(loaded);
    jump.dispose();
    lease.release();
  }
});
