import { expect, test } from "vitest";
import { setup } from "./translator.test-helper.ts";

test("Codex RPC receipts and handled lifecycle events never become transcript notices", () => {
  const h = setup();
  h.send("initialize", {}, 1);
  h.feed({ seq: 100, t: 100, dir: "recv", channel: "stdio", data: { id: 1, result: {} } });
  h.start();
  h.recv("thread/tokenUsage/updated", {
    threadId: "native",
    tokenUsage: { last: { totalTokens: 12, inputTokens: 10, outputTokens: 2 } },
  });
  h.end();
  expect(Object.values(h.state.items).filter((item) => item.type === "notice")).toEqual([]);
  expect(h.state.status.state).toBe("done");
});
