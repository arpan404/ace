import { expect, test } from "vitest";
import { z } from "zod";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

test("shutdown during inherited output drain stays bounded and preserves natural process loss", async () => {
  const draining = Promise.withResolvers<void>();
  let advanceDrain: (() => void) | undefined;
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
        if (delay === 250) {
          advanceDrain = callback;
          draining.resolve();
        }
        return () => {};
      },
    },
  );
  let helper: number | undefined;
  try {
    await h.session.send([{ type: "text", text: "escaped-pipes" }], "steer");
    const frame = await h.wait((f) => obj(f.data)["method"] === "test/helper");
    helper = z
      .number()
      .int()
      .positive()
      .parse(obj(obj(frame.data)["params"])["pid"]);
    await draining.promise;
    const closing = h.session.close("shutdown");
    advanceDrain?.();
    expect(
      await Promise.race([
        closing.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(resolve, 1000, false)),
      ]),
    ).toBe(true);
    expect((await h.exited).deliberate).toBe(false);
    expect(h.exits).toHaveLength(1);
    expect(h.replay.state.status.state).toBe("failed");
    expect(h.replay.state.items["final-output"]).toMatchObject({
      parts: [{ type: "text", text: "accepted final output" }],
    });
  } finally {
    if (helper !== undefined) {
      try {
        process.kill(helper, "SIGKILL");
      } catch {
        /* The helper may already be gone. */
      }
    }
    await h.dispose();
  }
});
