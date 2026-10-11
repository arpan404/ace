import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

test.each(["read-after-observed", "read-after-observed-stale"])(
  "child recovery preserves the newest execution across %s",
  async (mode) => {
    const h = await sessionHarness(false, mode);
    try {
      await h.session.send([{ type: "text", text: "hidden-child" }], "steer");
      await h.wait((f) => obj(f.data)["event"] === "discovery-finished");
      if (mode === "read-after-observed") {
        expect(h.replay.state.status.state).toBe("working");
        await h.session.interrupt({ agent: "hidden", cascade: false });
        await h.wait((f) => {
          const data = obj(f.data);
          const params = obj(data["params"]);
          return (
            data["method"] === "turn/completed" &&
            params["threadId"] === "hidden" &&
            obj(params["turn"])["id"] === "hidden-turn"
          );
        });
      }
      expect(h.replay.state.status.state).toBe("done");
    } finally {
      await h.dispose();
    }
  },
);
