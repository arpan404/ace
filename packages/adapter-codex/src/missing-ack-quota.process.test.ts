import { expect, test } from "vitest";
import { z } from "zod";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

function clock() {
  let now = 0;
  const scheduled = new Map<() => void, number>();
  return {
    runtime: {
      now: () => now,
      schedule(callback: () => void, delay: number) {
        scheduled.set(callback, now + delay);
        return () => {
          scheduled.delete(callback);
        };
      },
    },
    advance(ms: number) {
      now += ms;
      const due = Array.from(scheduled);
      for (const [callback, deadline] of due) {
        if (deadline > now) continue;
        scheduled.delete(callback);
        callback();
      }
    },
  };
}

test.each([
  { text: "quota", state: "waiting" },
  { text: "quota-with-late-boundaries", state: "working" },
])(
  "a missing start acknowledgement retires a live provider and settles unresolved completion ($text)",
  async ({ text, state }) => {
    const time = clock();
    const h = await sessionHarness(
      false,
      "missing-start-ack",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      time.runtime,
    );
    try {
      await h.session.send([{ type: "text", text: "first" }], "steer");
      await h.wait((f) => obj(f.data)["event"] === "discovery-finished");
      expect(h.replay.state.status.state).toBe("done");
      const sending = h.session.send([{ type: "text", text }], "steer").then(
        () => undefined,
        (error: unknown) => error,
      );
      const alive = await h.wait((f) => obj(f.data)["method"] === "test/provider-alive");
      const pid = z
        .number()
        .int()
        .positive()
        .parse(obj(obj(alive.data)["params"])["pid"]);
      await h.wait((f) => {
        const data = obj(f.data);
        return data["event"] === "discovery-finished" && data["task"] === "discovery:late-2";
      });
      time.advance(29_999);
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(h.exits).toEqual([]);
      expect(h.replay.state.status.state).toBe(state);
      time.advance(1);
      const exit = await Promise.race([
        h.exited,
        new Promise<undefined>((resolve) => setTimeout(resolve, 1000, undefined)),
      ]);
      expect(exit?.deliberate).toBe(false);
      expect(await sending).toBeInstanceOf(Error);
      expect(h.replay.state.status.state).toBe("failed");
      expect(
        Object.values(h.replay.state.tasks).filter((task) => task.status === "running"),
      ).toEqual([]);
      await expect(h.session.interrupt({ cascade: false })).rejects.toThrow("session is closed");
      await h.session.close("shutdown");
      expect(h.exits).toHaveLength(1);
    } finally {
      await h.dispose();
    }
  },
);

test("a correlated completion cancels retirement and keeps the quota limit actionable", async () => {
  const time = clock();
  const h = await sessionHarness(
    false,
    "complete-before-ack",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    time.runtime,
  );
  try {
    await h.session.send([{ type: "text", text: "first" }], "steer");
    await h.wait((f) => obj(f.data)["event"] === "discovery-finished");
    await h.session.send([{ type: "text", text: "quota" }], "steer");
    time.advance(30_000);
    expect(h.exits).toEqual([]);
    expect(h.replay.state.status.state).toBe("limited");
    await h.session.interrupt({ cascade: false });
  } finally {
    await h.dispose();
  }
});
