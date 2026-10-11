import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

test("item-only invalidation keeps unseen active child recovery pending until a current retry", async () => {
  const h = await sessionHarness(false, "read-after-observed-item");
  try {
    await h.session.send([{ type: "text", text: "hidden-child" }], "steer");
    const first = await h.wait((f) => obj(f.data)["event"] === "thread-discovered");
    await h.wait((f) => obj(f.data)["event"] === "discovery-finished");
    expect(h.replay.state.status.state).not.toBe("done");
    h.runTimers();
    await h.wait((f) => f.seq > first.seq && obj(f.data)["event"] === "thread-discovered");
    expect(h.replay.state.status.state).toBe("working");
    await h.session.interrupt({ agent: "hidden", cascade: false });
    await h.wait((f) => {
      const data = obj(f.data);
      const params = obj(data["params"]);
      return data["method"] === "turn/completed" && params["threadId"] === "hidden" &&
        obj(params["turn"])["id"] === "hidden-turn";
    });
    expect(h.replay.state.status.state).toBe("done");
  } finally {
    await h.dispose();
  }
});
