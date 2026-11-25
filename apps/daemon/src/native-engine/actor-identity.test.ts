// SPDX-License-Identifier: Apache-2.0
import type { ThreadId } from "@ace/protocol";
import { describe, expect, test } from "vitest";

import { bareSeam, frame, native, tick, track, translator } from "./actor-support.ts";

const thread = (id: string): ThreadId => id as ThreadId;

describe.runIf(native)("evicted actor effects", () => {
  test("a queued retirement leaves the replacement generation intact", async () => {
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    try {
      const session = await seam.probe.attachSession("a", { translator: translator() });
      seam.probe.enqueueRetire("a");
      seam.engine.rootAgent(thread("b"));
      seam.engine.rootAgent(thread("a"));
      await seam.engine.flush();
      expect(session.log().expired).toEqual([0]);
      expect(seam.probe.generation("a")).toBe(0);
    } finally {
      await seam.close();
    }
  });

  test("an evicted overflow leaves the replacement deadline armed", async () => {
    const seam = await bareSeam({ limits: { maxActiveThreads: 1, maxQueuedFrames: 1 } });
    try {
      await seam.probe.attachSession("a", { translator: translator() });
      seam.probe.enqueue("a", "accepted");
      seam.probe.enqueue("a", "overflow");
      seam.engine.rootAgent(thread("b"));
      const deadline = seam.clock.time + 50;
      const replacement = await seam.probe.attachSession("a", {
        translator: translator(() => (seam.clock.time < deadline ? deadline : undefined)),
      });
      seam.probe.schedule("a");
      await tick();
      seam.clock.advance(deadline);
      await tick();
      expect(replacement.log().applied.at(-1)?.facts).toBe(2);
    } finally {
      await seam.close();
    }
  });

  test("a failed evicted batch leaves the replacement writable and its frame held", async () => {
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    try {
      const session = await seam.probe.attachSession("a", { translator: translator() });
      const old = track(session.context.onFrame(frame(0)));
      seam.probe.seal("a");
      const skipped = track(session.context.onFrame(frame(1)));
      seam.probe.seal("a");
      seam.engine.rootAgent(thread("b"));
      seam.engine.rootAgent(thread("a"));
      seam.probe.failApplyFatal("a", 1);
      const replacement = track(session.context.onFrame(frame(2)));
      await tick();
      expect(old.error).toBe("Provider frame failed to commit");
      expect(skipped.error).toBe("Provider frame failed to commit");
      expect(replacement.done).toBe(false);
      expect(seam.probe.liveFrames()).toBe(1);
      seam.probe.seal("a");
      await seam.engine.flush();
      expect(replacement.done).toBe(true);
      expect(replacement.error).toBeUndefined();
      expect(seam.probe.liveFrames()).toBe(0);
    } finally {
      await seam.close();
    }
  });

  test("an evicted task exits without unregistering its replacement waker", async () => {
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    try {
      const session = await seam.probe.attachSession("a", { translator: translator() });
      await tick();
      seam.probe.enqueue("a", "old");
      seam.engine.rootAgent(thread("b"));
      seam.engine.rootAgent(thread("a"));
      await tick();
      expect(seam.probe.registeredWakers()).toBe(1);
      seam.probe.enqueue("a", "replacement");
      await tick();
      expect(session.log().enqueued).toEqual(["old", "replacement"]);
    } finally {
      await seam.close();
    }
  });
});
