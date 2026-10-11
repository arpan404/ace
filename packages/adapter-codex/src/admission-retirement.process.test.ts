import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";

test("an oversized execution frame retires the provider and preserves unfinished work as failure", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send([{ type: "text", text: "oversized-execution" }], "steer");
    const exit = await Promise.race([
      h.exited,
      new Promise<undefined>((resolve) => setTimeout(resolve, 500, undefined)),
    ]);
    expect(exit?.deliberate).toBe(false);
    expect(h.exits).toHaveLength(1);
    expect(h.replay.state.status.state).toBe("failed");
    await expect(h.session.interrupt({ cascade: false })).rejects.toThrow("session is closed");
    await h.session.close("shutdown");
    expect(h.exits).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});
