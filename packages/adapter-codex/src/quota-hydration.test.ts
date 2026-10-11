import { expect, test } from "vitest";
import { setup } from "./translator.test-helper.ts";

test.each(["missing start", "late acknowledgement"])(
  "an orphaned older quota completion with %s preserves the newer successful outcome",
  (mode) => {
    const h = setup();
    if (mode === "late acknowledgement") h.send("turn/start", { threadId: "native" }, 41);
    h.start("native", "new");
    h.end("completed", "native", "new");
    if (mode === "late acknowledgement")
      h.feed({
        seq: 41,
        t: 41,
        dir: "recv",
        channel: "stdio",
        data: { id: 41, result: { turn: { id: "old" } } },
      });
    h.recv("turn/completed", {
      threadId: "native",
      turn: {
        id: "old",
        status: "failed",
        error: { message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" },
      },
    });
    expect(h.state.status.state).toBe("done");
    expect(Object.values(h.state.runs).find((r) => r.nativeId === "old")?.state).toBe("failed");
  },
);

test.each(["first", "acknowledged"])(
  "a %s completion-only quota stream still limits current execution",
  (mode) => {
    const h = setup();
    if (mode === "acknowledged") {
      h.start("native", "prior");
      h.end("completed", "native", "prior");
      h.send("turn/start", { threadId: "native" }, 40);
      h.feed({
        seq: 40,
        t: 40,
        dir: "recv",
        channel: "stdio",
        data: { id: 40, result: { turn: { id: "next" } } },
      });
    }
    h.recv("turn/completed", {
      threadId: "native",
      turn: {
        id: "next",
        status: "failed",
        error: { message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" },
      },
    });
    expect(h.state.status.state).toBe("limited");
  },
);

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
