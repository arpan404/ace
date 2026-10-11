import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

test("quota before acknowledgement limits the thread and leaves no completed turn to steer", async () => {
  const h = await sessionHarness(false, "complete-before-ack");
  try {
    await h.session.send([{ type: "text", text: "first" }], "steer");
    await h.wait((f) => obj(f.data)["event"] === "discovery-finished");
    await h.session.send([{ type: "text", text: "quota" }], "steer");
    expect(h.replay.state.status.state).toBe("limited");
    h.replay.feedFact({ type: "limit.cleared", agent: "root" }, 100);
    await h.session.send([{ type: "text", text: "after reset" }], "steer");
    await h.wait((f) => {
      const data = obj(f.data);
      return (
        data["method"] === "turn/completed" && obj(obj(data["params"])["turn"])["id"] === "late-3"
      );
    });
    await h.wait((f) => {
      const data = obj(f.data);
      return data["event"] === "discovery-finished" && data["task"] === "discovery:late-3";
    });
    expect(h.replay.state.status.state).toBe("done");
  } finally {
    await h.dispose();
  }
});
