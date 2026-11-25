// SPDX-License-Identifier: Apache-2.0
/**
 * E5.2's native proof: the actor and frames behind `ACE_ENGINE=native`. Switch on, addon built
 * with `engine-probe`. Each case names the (a) file that will show it and is deleted when that
 * file passes with the switch on.
 */
import type { Frame } from "@ace/engine-api";
import { engineBackend } from "@ace/provider-kit/native-switches";
import { describe, expect, test } from "vitest";
import { engineSeam, type EngineSeam, type ProbeSession } from "./testing.ts";

const native = engineBackend() === "native";

/** A translator with no state: one signal fact per frame. */
function translator(nextDeadline?: () => number | undefined) {
  return {
    translate: () => [{ type: "signal" }],
    tick: (now: number) => [{ type: "signal", agent: "root", t: now }],
    takeDiagnostics: () => [],
    ...(nextDeadline === undefined ? {} : { nextDeadline }),
  } as never;
}

function frame(seq: number, data: unknown = { type: "x" }): Frame {
  return { seq, t: seq, dir: "recv", channel: "stdio", data } as unknown as Frame;
}

async function seamWithSession(
  options: {
    limits?: Record<string, number>;
    deadline?: () => number | undefined;
  } = {},
): Promise<{ seam: EngineSeam; session: ProbeSession }> {
  const seam = await engineSeam(
    options.limits === undefined ? {} : { options: { limits: options.limits } },
  );
  await seam.engine.ready();
  const session = await seam.probe.attachSession("t1", {
    translator: translator(options.deadline),
  });
  return { seam, session };
}

/** Lets the pump's macrotasks run. Deterministic: no sleeps, only the event loop. */
async function tick(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

describe.runIf(native)("the native actor and frames", () => {
  test("a batch's frames are acknowledged after its commit, never before", async () => {
    const { seam, session } = await seamWithSession();
    try {
      const order: number[] = [];
      const promises = [0, 1, 2].map((index) =>
        session.context.onFrame(frame(index)).then(() => {
          order.push(index);
        }),
      );
      await tick(2);
      expect(order).toEqual([]);
      seam.clock.advance(seam.clock.time + 1);
      await seam.engine.flush();
      await Promise.all(promises);
      expect(order).toEqual([0, 1, 2]);
      const log = session.log();
      expect(log.applied.length).toBe(1);
      expect(log.applied[0]?.outermost).toBe(true);
      expect(log.applied[0]?.committed).toBe(true);
    } finally {
      await seam.close();
    }
  });

  test("a batch seals at 256 frames or 256 KiB without waiting for its timer", async () => {
    const { seam, session } = await seamWithSession();
    try {
      for (let index = 0; index < 256; index += 1) {
        void session.context.onFrame(frame(index));
      }
      await seam.engine.flush();
      expect(session.log().applied.map((entry) => entry.facts)).toEqual([256]);
      const wide = "y".repeat(130 * 1024);
      void session.context.onFrame(frame(300, { type: "x", payload: wide }));
      void session.context.onFrame(frame(301, { type: "x", payload: wide }));
      await seam.engine.flush();
      expect(session.log().applied.map((entry) => entry.facts)).toEqual([256, 2]);
    } finally {
      await seam.close();
    }
  });

  test("a frame that arrives after the batch timer fired joins the next batch", async () => {
    const { seam, session } = await seamWithSession();
    try {
      void session.context.onFrame(frame(0));
      seam.clock.advance(seam.clock.time + 1);
      void session.context.onFrame(frame(1));
      await seam.engine.flush();
      expect(session.log().applied.map((entry) => entry.facts)).toEqual([1, 1]);
    } finally {
      await seam.close();
    }
  });

  test("a batch whose timer fires with no later frame, flush or tick is still committed", async () => {
    const { seam, session } = await seamWithSession();
    try {
      let settled = false;
      void session.context.onFrame(frame(0)).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      seam.clock.advance(seam.clock.time + 1);
      await tick(16);
      expect(settled).toBe(true);
      expect(session.log().applied.length).toBe(1);
    } finally {
      await seam.close();
    }
  });

  test("an actor tick that fires on an idle actor runs", async () => {
    let clock = 0;
    const { seam, session } = await seamWithSession({
      deadline: () => clock + 1000,
    });
    try {
      clock = seam.clock.now();
      void session.context.onFrame(frame(0));
      await seam.engine.flush();
      expect(session.log().applied.length).toBe(1);
      seam.clock.advance(clock + 1000);
      await tick(16);
      const applied = session.log().applied;
      expect(applied.length).toBe(2);
      // The translator's tick facts, then the engine's own tick.
      expect(applied[1]?.facts).toBe(2);
    } finally {
      await seam.close();
    }
  });

  test("a frame of a retired generation is acknowledged and dropped", async () => {
    const { seam, session } = await seamWithSession();
    try {
      void session.context.onFrame(frame(0));
      await seam.engine.flush();
      expect(session.log().applied.length).toBe(1);
      session.retire();
      let settled = false;
      await session.context.onFrame(frame(1)).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      expect(settled).toBe(true);
      expect(session.log().applied.length).toBe(1);
    } finally {
      await seam.close();
    }
  });
});
