import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { adapter } from "./index.ts";
// An empty streaming input performs initialize only. No prompt is ever supplied.
test.skipIf(process.env["ACE_LIVE_CLI"] !== "1")(
  "the installed CLI initializes without a model turn",
  async () => {
    const controller = new AbortController();
    const types: string[] = [];
    const session = await adapter.openSession({
      threadId: ThreadId.parse("live-initialize"),
      cwd: process.cwd(),
      signal: controller.signal,
      onFrame(frame) {
        if (typeof frame.data === "object" && frame.data !== null && "type" in frame.data)
          types.push(String(frame.data.type));
      },
      onExit() {},
    });
    try {
      expect(types).toContain("control_response");
      expect(types).not.toContain("user");
      expect(types).not.toContain("result");
    } finally {
      await session.close("shutdown");
    }
  },
);
