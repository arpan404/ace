import { screenTail } from "@ace/client";
import { ScenarioPlayer, flakyCheckout } from "@ace/fake-daemon";
import { afterEach, expect, test, vi } from "vitest";
import { cleanups, world } from "./worker-test-support.ts";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/*
 * The web client runs its store in a worker: a tab reads a mirror of it. While the worker's
 * store holds only a small tail, the tab's mirror must say so, and show its previews as cut,
 * until the full snapshot replaces the tail.
 */
test("a tab's mirror says a thread holds only its tail until the full snapshot lands", async () => {
  const { daemon, tab, faults } = world(undefined, {}, undefined, undefined, undefined, {
    openTail: screenTail,
  });
  const script = new ScenarioPlayer(daemon, flakyCheckout());
  script.runUntilBlocked();
  let snapshots = 0;
  let previewed = "";
  let complete: (() => void) | undefined;
  // The fake daemon has no tails: its first snapshot is marked as one a tail would send, with
  // its newest item named as a preview; the completing snapshot is held until released.
  faults.incoming = (message, text, deliver) => {
    if (message.type !== "snapshot" || message.view.kind !== "thread") return deliver(text);
    snapshots++;
    if (snapshots === 1) {
      previewed = message.view.itemOrder.at(-1) ?? "";
      return deliver(
        JSON.stringify({
          ...message,
          view: { ...message.view, partial: { previews: [previewed] } },
        }),
      );
    }
    complete = () => deliver(text);
  };
  const remote = tab();
  await remote.start();
  const lease = remote.thread(script.threadId);
  const filling = lease.store.select(["filling"], (reader) => reader.filling === true);
  await vi.waitFor(() => expect(filling.getSnapshot()).toBe(true));
  expect(previewed).not.toBe("");
  expect(lease.store.truncated(previewed)).toBe(true);
  await vi.waitFor(() => expect(complete).toBeDefined());
  complete?.();
  await vi.waitFor(() => expect(filling.getSnapshot()).toBe(false));
  expect(lease.store.truncated(previewed)).toBe(false);
  lease.release();
});
