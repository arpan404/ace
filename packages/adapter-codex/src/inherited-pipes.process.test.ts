import { expect, test } from "vitest";
import { z } from "zod";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

test.each(["escaped-pipes", "group-pipes"])(
  "provider exit and shutdown are bounded with %s",
  async (text) => {
    const h = await sessionHarness(
      false,
      "",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        schedule(callback, delay) {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
    );
    let helper: number | undefined;
    try {
      await h.session.send([{ type: "text", text }], "steer");
      const frame = await h.wait((f) => obj(f.data)["method"] === "test/helper");
      const pid = z
        .number()
        .int()
        .positive()
        .parse(obj(obj(frame.data)["params"])["pid"]);
      helper = pid;
      const exit = await Promise.race([
        h.exited,
        new Promise<undefined>((resolve) => setTimeout(resolve, 1000, undefined)),
      ]);
      expect(exit?.deliberate).toBe(false);
      expect(h.exits).toHaveLength(1);
      expect(h.replay.state.items["final-output"]).toMatchObject({
        type: "message",
        parts: [{ type: "text", text: "accepted final output" }],
      });
      expect(h.replay.state.status.state).toBe("failed");
      const closed = await Promise.race([
        h.session.close("shutdown").then(() => true),
        new Promise<boolean>((resolve) => setTimeout(resolve, 1000, false)),
      ]);
      expect(closed).toBe(true);
      if (text === "escaped-pipes") expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      if (helper !== undefined) {
        try {
          process.kill(helper, "SIGKILL");
        } catch {
          /* Same-group cleanup may already have stopped it. */
        }
      }
      await h.dispose();
    }
  },
);
