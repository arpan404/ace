import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

test("overlapping discovery paths cannot revive an old child after a newer turn completes", async () => {
  const h = await sessionHarness(false, "overlap-reads");
  try {
    await h.session.send([{ type: "text", text: "hidden-child" }], "steer");
    await h.wait((f) => obj(f.data)["method"] === "test/read-held");
    await h.session.send([{ type: "text", text: "newer" }], "steer");
    await h.wait((f) => obj(f.data)["method"] === "test/overlap-loaded");
    await h.session.send([{ type: "text", text: "release-read" }], "steer");
    for (const task of ["discovery:overlap-1", "discovery:overlap-2", "discovery:overlap-3"])
      await h.wait((f) => {
        const data = obj(f.data);
        return data["event"] === "discovery-finished" && data["task"] === task;
      });
    expect(h.replay.state.status.state).toBe("done");
    h.runTimers();
    await h.session.send([{ type: "text", text: "barrier" }], "steer");
    await h.wait((f) => {
      const data = obj(f.data);
      return data["event"] === "discovery-finished" && data["task"] === "discovery:overlap-4";
    });
    expect(h.replay.state.status.state).toBe("done");
  } finally {
    await h.dispose();
  }
});
