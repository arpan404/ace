// SPDX-License-Identifier: Apache-2.0
/**
 * E5.1's native proof (step 12): the executor, the pump and the wake semantics on real Bun
 * macrotasks and a real Store. Switch on, addon built with `engine-probe`.
 *
 * What each case will retire into once an (a) file can show it natively:
 * - timer order and the pump's macrotasks: `engine.process.test.ts`'s ordering cases (E5.6);
 * - after-commit release and drop, nesting and subscriber re-entry: `reliability.process`;
 * - promise identity and close: `engine.process`'s startup/shutdown cases (E5.6, E5.10).
 */
import { describe, expect, test } from "vitest";
import { engineBackend } from "@ace/provider-kit/native-switches";
import { engineSeam } from "./testing.ts";
import { AdapterRegistry } from "../engine/registry.ts";

const native = engineBackend() === "native";

/** Lets the pump's macrotasks run. Deterministic: no sleeps, only the event loop. */
async function tick(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

describe.runIf(native)("the engine skeleton", () => {
  test("ready resolves with the probe's empty candidate scan, and flush drains a write", async () => {
    const seam = await engineSeam();
    try {
      await seam.engine.ready();
      expect(seam.probe.claim()).toBe("idle");
      seam.probe.spawn("work", [{ op: "write", events: [], defer: "t1" }]);
      await seam.engine.flush();
      expect(seam.probe.woken()).toEqual(["t1"]);
    } finally {
      await seam.close();
    }
  });

  test("a committed write releases its wake, a rolled-back one drops it", async () => {
    const seam = await engineSeam();
    try {
      await seam.engine.ready();
      seam.probe.spawn("work", [
        { op: "write", events: [], defer: "committed" },
        { op: "write", events: [], defer: "rolled-back", fail: true },
      ]);
      await seam.engine.flush();
      expect(seam.probe.woken()).toEqual(["committed"]);
    } finally {
      await seam.close();
    }
  });

  test("a nested transaction releases both wakes once, in join order", async () => {
    const seam = await engineSeam();
    try {
      await seam.engine.ready();
      seam.probe.spawn("work", [
        {
          op: "write",
          events: [],
          defer: "outer",
          nested: { events: [], defer: "inner" },
        },
      ]);
      await seam.engine.flush();
      expect(seam.probe.woken()).toEqual(["outer", "inner"]);
    } finally {
      await seam.close();
    }
  });

  test("a JavaScript transaction inside a Rust one publishes and settles once", async () => {
    const seam = await engineSeam();
    try {
      await seam.engine.ready();
      const seen: string[] = [];
      const stop = seam.store.subscribe((events) => {
        for (const event of events) seen.push(event.payload.type);
      });
      try {
        seam.probe.setCallback(() => {
          // A port the Rust transaction's body calls opens a savepoint in the same context.
          seam.store.atomic(() => {
            seam.store.statement("SELECT 1").get();
          });
        });
        seam.probe.spawn("work", [{ op: "js" }, { op: "write", events: [], defer: "t1" }]);
        await seam.engine.flush();
        expect(seam.probe.woken()).toEqual(["t1"]);
      } finally {
        stop();
      }
    } finally {
      await seam.close();
    }
  });

  test("a subscriber that throws still releases the transaction's wakes", async () => {
    const seam = await engineSeam();
    try {
      await seam.engine.ready();
      const stop = seam.store.subscribe(() => {
        throw new Error("subscriber failed");
      });
      try {
        seam.probe.spawn("work", [{ op: "write", events: [], defer: "t1" }]);
        await seam.engine.flush();
        expect(seam.probe.woken()).toEqual(["t1"]);
      } finally {
        stop();
      }
    } finally {
      await seam.close();
    }
  });

  test("a flush from inside a task does not wait on itself", async () => {
    const seam = await engineSeam();
    try {
      await seam.engine.ready();
      seam.probe.spawn("work", [
        { op: "write", events: [], defer: "before" },
        { op: "flush" },
        { op: "mark", label: "after-flush" },
      ]);
      for (let index = 0; index < 50 && seam.probe.marks().length === 0; index += 1) await tick(1);
      expect(seam.probe.marks()).toEqual(["after-flush"]);
      expect(seam.probe.woken()).toEqual(["before"]);
    } finally {
      await seam.close();
    }
  });

  test("timers resume their tasks in the clock's firing order, in the next pump", async () => {
    const seam = await engineSeam();
    try {
      await seam.engine.ready();
      const start = seam.clock.time;
      seam.probe.spawn("work", [
        { op: "timer", ms: 20 },
        { op: "mark", label: "late" },
      ]);
      seam.probe.spawn("work", [
        { op: "timer", ms: 10 },
        { op: "mark", label: "early" },
      ]);
      await tick();
      seam.clock.advance(start + 20);
      await tick();
      // ManualClock.advance fires its timers in registration order, as today's tests rely on.
      expect(seam.probe.marks()).toEqual(["late", "early"]);
    } finally {
      await seam.close();
    }
  });

  test("a missing async binding rejects, and never throws synchronously", async () => {
    const seam = await engineSeam();
    try {
      await seam.engine.ready();
      const promise = seam.engine.retrySettled("t1" as never);
      expect(promise).toBeInstanceOf(Promise);
      await expect(promise).rejects.toThrow(/NativeEngineIncomplete: retrySettled lands in E5.10/);
    } finally {
      await seam.close();
    }
  });

  test("ready and close return the same promise object on every call", async () => {
    const seam = await engineSeam();
    try {
      const ready = seam.engine.ready();
      expect(seam.engine.ready()).toBe(ready);
      const closing = seam.engine.close();
      expect(seam.engine.close()).toBe(closing);
      await closing;
      expect(seam.engine.close()).toBe(closing);
    } finally {
      await seam.store.close();
    }
  });

  test("a failed ready still shuts down, and close reports that readiness error", async () => {
    const seam = await engineSeam({
      options: {
        providersActivated: (() => {
          const failed = Promise.reject(new Error("providers never came up"));
          failed.catch(() => {});
          return failed;
        })(),
      },
    });
    try {
      await expect(seam.engine.ready()).rejects.toThrow("providers never came up");
      await expect(seam.engine.close()).rejects.toThrow("providers never came up");
      expect(seam.probe.claim()).toBe("idle");
    } finally {
      await seam.store.close();
    }
  });

  test("close finishes inside its deadline when the readiness wait stalls", async () => {
    const seam = await engineSeam({
      options: { providersActivated: new Promise<void>(() => {}) },
    });
    try {
      // The close rejects the still-pending ready promise; attach before it settles.
      void seam.engine.ready().catch(() => {});
      const closing = seam.engine.close();
      await tick();
      let settled = false;
      void closing.then(
        () => (settled = true),
        () => (settled = true),
      );
      seam.clock.advance(seam.clock.now() + 4_400);
      await tick();
      expect(settled).toBe(false);
      seam.clock.advance(seam.clock.now() + 100);
      await tick(20);
      expect(settled).toBe(true);
      await closing;
      expect(native).toBe(true);
      const reported = seam.ports.calls
        .filter((call) => call.port === "onError")
        .map((call) => String(call.args[0]));
      expect(
        reported.some((message) =>
          message.includes("Engine close passed its 4.5 s deadline during readiness"),
        ),
      ).toBe(true);
      await expect(seam.engine.ready()).rejects.toThrow("Engine closed");
    } finally {
      await seam.store.close();
    }
  });

  test("close finishes inside its deadline when a module step stalls", async () => {
    const seam = await engineSeam();
    try {
      await seam.engine.ready();
      seam.probe.stallCloseStep(() => new Promise<void>(() => {}));
      const closing = seam.engine.close();
      await tick();
      seam.clock.advance(seam.clock.now() + 4_500);
      await tick(20);
      await closing;
      const report = seam.ports.calls
        .filter((call) => call.port === "onError")
        .map((call) => String(call.args[0]));
      expect(
        report.some((message) =>
          message.includes("Engine close passed its 4.5 s deadline during probe close"),
        ),
      ).toBe(true);
    } finally {
      await seam.store.close();
    }
  });

  test("close finishes inside its deadline when a worker waits on a port that never settles", async () => {
    const seam = await engineSeam({
      options: { waitForProvider: () => new Promise<void>(() => {}) },
    });
    try {
      await seam.engine.ready();
      seam.probe.stallWorker("t1", "prepareInput", "waitForProvider");
      const call = seam.engine.ensureProvider("codex");
      void call.catch(() => {});
      await tick();
      seam.clock.advance(seam.clock.now() + 4_500);
      await tick(20);
      await seam.engine.close();
      await expect(call).rejects.toMatchObject({ code: "ACE_ENGINE_CLOSED" });
      const reported = seam.ports.calls
        .filter((entry) => entry.port === "onError")
        .map((entry) => String(entry.args[0]));
      expect(
        reported.some((message) =>
          message.includes("Engine closed while prepareInput for t1 waited on waitForProvider"),
        ),
      ).toBe(true);
    } finally {
      await seam.store.close();
    }
  });

  test("close joins a commit admitted before admission closed", async () => {
    const seam = await engineSeam();
    try {
      await seam.engine.ready();
      const before = seam.clock.now();
      // The commit is admitted (queued) before close; the join runs it and releases its wake.
      seam.probe.spawn("work", [{ op: "write", events: [], defer: "t1" }]);
      await seam.engine.close();
      expect(seam.probe.woken()).toEqual(["t1"]);
      expect(seam.clock.now()).toBe(before);
      expect(seam.probe.claim()).toBe("idle");
    } finally {
      await seam.store.close();
    }
  });

  test("a shutdown join longer than one budget completes over several macrotasks", async () => {
    const seam = await engineSeam();
    try {
      await seam.engine.ready();
      for (let index = 0; index < 200; index += 1)
        seam.probe.spawn("work", [{ op: "mark", label: `task-${index}` }]);
      const before = (await seam.probe.turns()).turns.length;
      await seam.engine.close();
      const after = (await seam.probe.turns()).turns.length;
      expect(after).toBeGreaterThan(before + 1);
      expect(seam.probe.marks()).toHaveLength(200);
    } finally {
      await seam.store.close();
    }
  });

  test("a native engine gets the registry's entries through observe", async () => {
    const registry = new AdapterRegistry();
    const seam = await engineSeam({ options: { registry } });
    try {
      await seam.engine.ready();
      expect(() => seam.engine.providerAvailability("codex")).toThrow(/isn't ready/);
    } finally {
      await seam.close();
    }
  });

  test("the registry's observe calls the listener at subscribe and unsubscribes", () => {
    const registry = new AdapterRegistry();
    const seen: number[] = [];
    const stop = registry.observe((entries) => seen.push(entries.length));
    expect(seen).toEqual([0]);
    stop();
    registry.register(
      {
        provider: "codex",
        capabilities: () => ({}) as never,
        createTranslator: () => ({}) as never,
        openSession: async () => ({}) as never,
      } as never,
      { installed: false, auth: "unknown" } as never,
    );
    expect(seen).toEqual([0]);
  });
});
