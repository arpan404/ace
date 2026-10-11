import { FakeDaemon, facts } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { expect, it } from "vitest";
import { fakeClient } from "@/test/harness.tsx";
import * as loaded from "./jump-controller.ts";
import { Jump } from "./jump.ts";

it.each(["live", "dispose"] as const)(
  "%s abandons a historical target while its navigation chunk is still loading",
  async (cancel) => {
    const daemon = new FakeDaemon({ clock: () => 1 });
    daemon.createThread({ id: "linked", workspaceId: "ace", title: "Linked", provider: "codex" });
    daemon.apply("linked", [
      facts.rootAgent("codex"),
      facts.message("root", "abandoned", "assistant", "Abandoned history"),
      facts.message("root", "fresh", "assistant", "Chosen history"),
    ]);
    const items = daemon
      .replay({ kind: "thread", threadId: ThreadId.parse("linked") }, 0)
      .flatMap((event) => (event.payload.type === "item.created" ? [event.payload.item.id] : []));
    const abandoned = items[0];
    const fresh = items[1];
    if (!abandoned || !fresh) throw new Error("No history items");
    const client = fakeClient(daemon);
    await client.start();
    const chunk = Promise.withResolvers<typeof loaded>();
    const jump = new Jump(client, "linked", () => chunk.promise);
    const queued = jump.toItem(abandoned);
    if (cancel === "live") jump.live();
    else jump.dispose();
    chunk.resolve(loaded);
    await queued;
    expect(jump.snapshot().window).toBeUndefined();
    expect(jump.snapshot().focus).toBeUndefined();
    // The same view can accept a later route or remount without reviving the abandoned link.
    await jump.toItem(fresh);
    expect(jump.snapshot().window?.items.map((item) => item.id)).toContain(fresh);
    expect(jump.snapshot().focus?.itemId).toBe(fresh);
    jump.dispose();
  },
);
