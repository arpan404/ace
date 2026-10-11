import { expect, test } from "vitest";
import { setup } from "./translator.test-helper.ts";

test("resuming past a cleared quota failure does not limit a successful conversation", () => {
  const h = setup();
  h.send("thread/resume", { threadId: "native" }, 10);
  h.feed({
    seq: 10,
    t: 10,
    dir: "recv",
    channel: "stdio",
    data: {
      id: 10,
      result: {
        thread: {
          id: "native",
          status: { type: "idle" },
          turns: [
            {
              id: "old",
              status: "failed",
              error: { message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" },
              items: [],
            },
            {
              id: "new",
              status: "completed",
              items: [{ id: "answer", type: "agentMessage", text: "Recovered successfully" }],
            },
          ],
        },
      },
    },
  });
  expect(h.state.status.state).toBe("done");
  expect(Object.values(h.state.runs)).toHaveLength(2);
});
